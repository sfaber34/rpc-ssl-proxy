const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// const rpcFunderContractAddress = "0x291469065a4DDdE2CA9f6A53ab4Aa148B8e42f48";
const backgroundTasksInterval = 10; //seconds

// Rate limiting configuration
// Origins (deployed apps) get a higher limit since they represent apps with many users
// IPs with no origin (local testing) get a lower limit since they represent individual developers
const originRateLimitPerHour = 10;  // Max requests per hour for a single origin (deployed app)
const ipRateLimitPerHour = 10;      // Max requests per hour for an IP with no origin (local testing)
const rateLimitPollInterval = 10;     // How often to poll DB for rate limit data (seconds)

export {
  usdcAddress,
  // rpcFunderContractAddress,
  backgroundTasksInterval,
  originRateLimitPerHour,
  ipRateLimitPerHour,
  rateLimitPollInterval
};