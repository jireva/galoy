import {
  BTC_NETWORK,
  getFailedLoginAttemptPerIpLimits,
  getFailedLoginAttemptPerPhoneLimits,
  VALIDITY_TIME_CODE,
} from "@config/app"
import { CouldNotFindUserFromPhoneError } from "@domain/errors"
import { RateLimitPrefix } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { createToken } from "@services/jwt"
import { UsersRepository } from "@services/mongoose"
import { PhoneCodesRepository } from "@services/mongoose/phone-code"
import { RedisRateLimitService } from "@services/rate-limit"
import { TwilioClient } from "@services/twilio"
import { isTestAccountPhoneAndCode } from "."

export const login = async ({
  phone,
  code,
  logger,
  ip,
}: {
  phone: PhoneNumber
  code: PhoneCode
  logger: Logger
  ip: IpAddress
}): Promise<JwtToken | ApplicationError> => {
  const subLogger = logger.child({ topic: "login" })

  {
    const limitOk = await checkFailedLoginAttemptPerIpLimits(ip)
    if (limitOk instanceof Error) return limitOk
  }

  {
    const limitOk = await checkFailedLoginAttemptPerPhoneLimits(phone)
    if (limitOk instanceof Error) return limitOk
  }

  // TODO:
  // add fibonachi on failed login
  // https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#dynamic-block-duration

  const age = VALIDITY_TIME_CODE
  const validCode = await isCodeValid({ phone, code, age })
  if (validCode instanceof Error) return validCode

  await rewardFailedLoginAttemptPerIpLimits(ip)

  const userRepo = UsersRepository()
  let user: RepositoryError | User = await userRepo.findByPhone(phone)

  if (user instanceof CouldNotFindUserFromPhoneError) {
    subLogger.info({ phone }, "new user signup")

    const userRaw: NewUserInfo = { phone, phoneMetadata: null }

    const carrierInfo = await TwilioClient().getCarrier(phone)
    if (carrierInfo instanceof Error) {
      // non fatal error
      subLogger.warn({ phone }, "impossible to fetch carrier")
    } else {
      userRaw.phoneMetadata = carrierInfo
    }

    user = await userRepo.persistNew(userRaw)
    if (user instanceof Error) return user
  } else if (user instanceof Error) {
    return user
  } else {
    subLogger.info({ phone }, "user login")
  }

  const network = BTC_NETWORK
  return createToken({ uid: user.id, network })
}

const checkFailedLoginAttemptPerIpLimits = async (
  ip: IpAddress,
): Promise<true | RateLimiterExceededError> => {
  const limiter = RedisRateLimitService({
    keyPrefix: RateLimitPrefix.failedLoginAttemptPerIp,
    limitOptions: getFailedLoginAttemptPerIpLimits(),
  })
  return limiter.consume(ip)
}

const rewardFailedLoginAttemptPerIpLimits = async (
  ip: IpAddress,
): Promise<true | RateLimiterExceededError> => {
  const limiter = RedisRateLimitService({
    keyPrefix: RateLimitPrefix.failedLoginAttemptPerIp,
    limitOptions: getFailedLoginAttemptPerIpLimits(),
  })
  return limiter.reward(ip)
}

const checkFailedLoginAttemptPerPhoneLimits = async (
  phone: PhoneNumber,
): Promise<true | RateLimiterExceededError> => {
  const limiter = RedisRateLimitService({
    keyPrefix: RateLimitPrefix.failedLoginAttemptPerPhone,
    limitOptions: getFailedLoginAttemptPerPhoneLimits(),
  })
  return limiter.consume(phone)
}

const isCodeValid = async ({
  code,
  phone,
  age,
}: {
  phone: PhoneNumber
  code: PhoneCode
  age: Seconds
}) => {
  const validTestCode = isTestAccountPhoneAndCode({ code, phone })

  if (validTestCode) {
    return true
  } else {
    return PhoneCodesRepository().existNewerThan({ code, phone, age })
  }
}
