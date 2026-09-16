-- One atomic operation per EVAL. Money/calls are integer units. No source/query data.
-- All keys share one hash tag. Redis TIME is authoritative for leases/rate windows.
local operation = ARGV[1]
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local leaseMs = 45000

if operation == 'admit' then
  -- KEYS: global-active, session-active, IP rolling log, token bucket, request lease
  local requestId = ARGV[2]
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - 60000)
  if redis.call('EXISTS', KEYS[5]) == 1 then
    local score = tonumber(redis.call('ZSCORE', KEYS[1], requestId) or '0')
    if redis.call('HGET', KEYS[5], 'state') == 'active' and score > now
      and redis.call('GET', KEYS[2]) == requestId then return {1, 0} end
    return {0, 1}
  end
  -- Count submissions, including rejected ones, once by server-issued request ID.
  redis.call('ZADD', KEYS[3], 'NX', now, requestId)
  redis.call('PEXPIRE', KEYS[3], 120000)
  local retryMs = 0
  local sessionRequest = redis.call('GET', KEYS[2])
  if sessionRequest then retryMs = math.max(retryMs, redis.call('PTTL', KEYS[2])) end
  if redis.call('ZCARD', KEYS[1]) >= 3 then
    local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    retryMs = math.max(retryMs, tonumber(first[2]) - now)
  end
  local ipCount = redis.call('ZCARD', KEYS[3])
  if ipCount > 120 then
    -- Enough old submissions must expire to leave room for one new request.
    local first = redis.call('ZRANGE', KEYS[3], ipCount - 120, ipCount - 120, 'WITHSCORES')
    retryMs = math.max(retryMs, tonumber(first[2]) + 60000 - now)
  end
  local tokens = tonumber(redis.call('HGET', KEYS[4], 'tokens') or '10')
  local updated = tonumber(redis.call('HGET', KEYS[4], 'updated') or now)
  tokens = math.min(10, tokens + math.max(0, now - updated) / 3000)
  if tokens < 1 then retryMs = math.max(retryMs, math.ceil((1 - tokens) * 3000)) end
  redis.call('HSET', KEYS[4], 'tokens', tokens, 'updated', now)
  redis.call('PEXPIRE', KEYS[4], 60000)
  if retryMs > 0 then return {0, math.max(1, math.ceil(retryMs / 1000))} end
  redis.call('HSET', KEYS[4], 'tokens', tokens - 1)
  redis.call('ZADD', KEYS[1], now + leaseMs, requestId)
  redis.call('SET', KEYS[2], requestId, 'PX', leaseMs)
  redis.call('HSET', KEYS[5], 'state', 'active', 'sessionKey', KEYS[2])
  -- Keep a completed/expired request tombstone to reject accidental replay.
  redis.call('PEXPIRE', KEYS[5], 86400000)
  return {1, 0}
end

if operation == 'check' or operation == 'renew' then
  -- KEYS: lease, active, session. Renew only an already live request.
  local id = ARGV[2]
  local expiry = tonumber(redis.call('ZSCORE', KEYS[2], id) or '0')
  if expiry <= now or redis.call('HGET', KEYS[1], 'state') ~= 'active'
    or redis.call('GET', KEYS[3]) ~= id then return 0 end
  if operation == 'renew' then
    redis.call('ZADD', KEYS[2], now + leaseMs, id)
    redis.call('PEXPIRE', KEYS[3], leaseMs)
  end
  return 1
end

if operation == 'reserve' then
  -- KEYS: reservation, aggregate-used, request-used, lease, active, session, metadata
  -- ARGV: operation, units, aggregate ceiling, request ceiling, request ID
  if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
  local expiry = tonumber(redis.call('ZSCORE', KEYS[5], ARGV[5]) or '0')
  if expiry <= now or redis.call('HGET', KEYS[4], 'state') ~= 'active'
    or redis.call('GET', KEYS[6]) ~= ARGV[5] then return -1 end
  local amount = tonumber(ARGV[2])
  local total = tonumber(redis.call('GET', KEYS[2]) or '0')
  local request = tonumber(redis.call('GET', KEYS[3]) or '0')
  if total + amount > tonumber(ARGV[3]) then return 0 end
  if request + amount > tonumber(ARGV[4]) then return 0 end
  redis.call('SET', KEYS[1], amount)
  redis.call('INCRBY', KEYS[2], amount)
  redis.call('INCRBY', KEYS[3], amount)
  redis.call('HSET', KEYS[7], 'aggregateKey', KEYS[2], 'requestKey', KEYS[3])
  -- No TTL: expired leases cannot refund unsettled/uncertain provider charges.
  return 1
end

if operation == 'settle' then
  if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
  if ARGV[2] == 'unknown' then return 1 end
  local settled = redis.call('HGET', KEYS[2], 'settled')
  if settled then
    if tonumber(settled) == tonumber(ARGV[2]) then return 1 else return 0 end
  end
  local actual = tonumber(ARGV[2])
  local reserved = tonumber(redis.call('GET', KEYS[1]))
  local difference = actual - reserved
  -- Record known over-estimates AND under-estimates; later reservations see actual use.
  redis.call('INCRBY', redis.call('HGET', KEYS[2], 'aggregateKey'), difference)
  redis.call('INCRBY', redis.call('HGET', KEYS[2], 'requestKey'), difference)
  redis.call('HSET', KEYS[2], 'settled', actual)
  return 1
end

if operation == 'release' then
  local session = redis.call('HGET', KEYS[1], 'sessionKey')
  if session and redis.call('GET', session) == ARGV[2] then redis.call('DEL', session) end
  redis.call('ZREM', KEYS[2], ARGV[2])
  if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'state', 'closed') end
  return 1
end
return redis.error_reply('UNKNOWN_LEDGER_OPERATION')
