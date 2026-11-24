# Changelog

## 0.1.0 (unreleased)

- First version: Fleet Route Optimizer node with resource Route and operations
  Optimize (wait for the result or return a job ID), Get Result and Check Request.
- Each input item is one stop (address or latitude/longitude, optional demand,
  service minutes and time window). Depot by address or latitude/longitude;
  identical vehicles or a vehicle list with capacity and driver name, phone and email.
- Output one item per route (stop list, driver link, Google Maps links) or one
  item per stop (route, sequence, arrival), or the raw result.
- Limits checked before sending (100 stops, 50 addresses, 25 vehicles) and clear
  errors for the rate limits and for a busy server.
- Talks to the service's REST API (`/api/v1/routes`); HTTP 429 and 503 replies
  are turned into the rate-limit and busy errors, using the Retry-After header.
