-- Sugo rider routing profile: OSRM's stock car profile, no road faster than
-- MAX_KMH.
--
-- Why: the car profile prices trunk roads at 85 km/h, and OSRM chooses routes
-- by that speed. From Banga to Tacurong it therefore took a 52.9 km detour up
-- the Isulan-Surallah Road (50 min at 85 km/h) over the 44.8 km Maharlika
-- Highway route Google also takes (52 min). No motorcycle rider averages 85
-- km/h through barangays, and a route chosen on that assumption sends them the
-- long way. Capping the speed here changes which road is chosen, not just the
-- number quoted afterwards (server/src/lib/routing/speedCap.ts only does the
-- latter, and stays as a backstop).
--
-- Everything else (access, oneways, turn penalties, names) is the car profile
-- exactly, loaded from the image rather than copied so an OSRM upgrade keeps it.

package.path = '/opt/?.lua;' .. package.path
local car = dofile('/opt/car.lua')

-- Keep in step with ROUTE_MAX_SPEED_KMH in server/src/config/env.ts.
local MAX_KMH = 60

-- Scales the rate (the routing weight) with the speed, so the cap reaches the
-- route choice. Capping the speed alone would leave the weights, and so the
-- chosen road, exactly as before.
local function cap(result, speed_key, rate_key)
  local speed = result[speed_key]
  if speed and speed > MAX_KMH then
    local factor = MAX_KMH / speed
    result[speed_key] = MAX_KMH
    local rate = result[rate_key]
    if rate and rate > 0 then
      result[rate_key] = rate * factor
    end
  end
end

local function process_way(profile, way, result, relations)
  car.process_way(profile, way, result, relations)
  cap(result, 'forward_speed', 'forward_rate')
  cap(result, 'backward_speed', 'backward_rate')
end

return {
  setup = car.setup,
  process_way = process_way,
  process_node = car.process_node,
  process_turn = car.process_turn,
}
