const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// const rpcFunderContractAddress = "0x291469065a4DDdE2CA9f6A53ab4Aa148B8e42f48";
const backgroundTasksInterval = 10; //seconds

// =============================================================================
// RATE LIMITING CONFIGURATION
// =============================================================================
// 
// We use a two-tier rate limiting system:
//   1. Sliding window hourly limit (smooths out hour-boundary gaming)
//   2. Daily limit (prevents sustained abuse across hours)
//
// Origins (deployed apps) get higher limits since they represent apps with many users.
// IPs with no origin (local testing) get lower limits since they represent individual developers.
//
// The sliding window uses an approximation: at any point in time, the effective
// request count = (current_hour_count) + (previous_hour_count × time_remaining_weight)
// This prevents users from "bursting" at hour boundaries.
// =============================================================================

// Hourly limits (used with sliding window approximation)
const originRateLimitPerHour = 10;  // Max requests per rolling hour for a single origin (deployed app)
const ipRateLimitPerHour = 10;      // Max requests per rolling hour for an IP with no origin (local testing)

// Daily limits (hard cap, resets at midnight UTC)
// Set these lower than 24× hourly to provide meaningful secondary protection
const originRateLimitPerDay = 50;  // Max requests per day for a single origin
const ipRateLimitPerDay = 50;      // Max requests per day for an IP with no origin

// Polling interval
const rateLimitPollInterval = 10;   // How often to poll DB for rate limit data (seconds)

export {
  usdcAddress,
  // rpcFunderContractAddress,
  backgroundTasksInterval,
  originRateLimitPerHour,
  ipRateLimitPerHour,
  originRateLimitPerDay,
  ipRateLimitPerDay,
  rateLimitPollInterval
};