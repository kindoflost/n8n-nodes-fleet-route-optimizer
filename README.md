# n8n-nodes-fleet-route-optimizer

An [n8n](https://n8n.io/) community node for the free **Fleet Route Optimizer**
([routing.kindoflost.com](https://routing.kindoflost.com)). It plans delivery or
service routes for one or more vehicles from one depot with Google OR-Tools
(guided local search over real road driving times) and returns, per vehicle,
the stop order, arrival times, load carried, a Google Maps link and a
**driver link**: a phone page with tap-to-navigate for every stop.

**No account, no API key, no credentials.** The service is free.

The node calls the service's public REST API (`https://routing.kindoflost.com/api/v1`).

[Installation](#installation) · [Operations](#operations) · [Inputs](#inputs) ·
[Output](#output) · [Usage example](#usage-example) · [Limits](#limits) · [Example workflow](#example-workflow) ·
[Compatibility](#compatibility) · [Privacy](#privacy)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and install `n8n-nodes-fleet-route-optimizer`.

## Operations

Resource **Route**:

| Operation | What it does |
| --- | --- |
| **Optimize** | Takes every input item as one stop and solves them together as one routing problem. Either waits for the routes (default, up to *Max Wait Seconds*) or returns a `job_id` at once. |
| **Get Result** | Fetches the result of an earlier Optimize run by `job_id` (results are kept 15 minutes after the solve finishes). |
| **Check Request** | Describe a routing problem in plain words; returns whether the service supports it and, if not, the closest thing it can do. No solve. |

## Inputs

**Stops**: one input item per stop. Each field is an expression, so map it from
your data (the defaults read `$json.id`, `$json.address`, `$json.lat`, `$json.lon`, ...):

- **Stop ID**: your label (customer, order number). Must be unique.
- **Stop Address**, or **Stop Latitude** and **Stop Longitude** (faster, never fails to geocode).
- Optional **Stop Fields**: Demand, Service Minutes, Time Window Open, Time Window Close.
  Times may be `HH:MM` (24 h), `8:30 AM`, or minutes after midnight.

**Depot**: an address, or latitude and longitude. **Departure Time** is when
vehicles may leave (default `08:00`); *Depot Closes At* (in Options) is when they
must be back.

**Vehicles**: either a number of identical vehicles with one capacity
(0 = unlimited), or a list with name, capacity and driver name, phone and email.
The driver's phone and email are **not sent** to the service; they are copied
onto that vehicle's output so a later node (Gmail, Twilio, ...) can send the
driver link.

**Country**: *United States* (US Census geocoder, then OpenStreetMap) or *Other* (OpenStreetMap).

**Search Seconds**: how long the solver searches (1-60; it stops earlier after
20 seconds without improvement). Results are the best routes found in the time
allowed, not a proof of optimality.

## Output

- **One Item per Route**: `route`, `vehicle`, `driver` (and `driver_phone` /
  `driver_email` if given), `stop_count`, `leave_depot`, `back_at_depot`,
  `route_minutes`, `load`, `driver_link`, `google_maps`, `sequence` (the stops in
  order with arrival times), plus the run summary (`totals`, `unserved`,
  `warnings`, ...).
- **One Item per Stop**: `status` (`served` or `unserved`), `stop`, `route`,
  `sequence`, `arrival`, `vehicle`, `driver`, `load_so_far`, `driver_link`, and
  the original input item under `input`. Unserved stops come last with a `reason`.
- **Raw Result**: one item with the full result.

With *Wait for Result* off, Optimize returns `{ status: "running", job_id }`; pass
it to a later **Get Result** node.

## Usage example

Three stops go in as three input items (from a Code node, a sheet, a database...):

```json
[
  {
    "json": {
      "id": "Stop 1",
      "lat": 41.70708,
      "lon": -81.25979,
      "demand": 46,
      "service_minutes": 20,
      "window_open": "09:45",
      "window_close": "12:45"
    }
  },
  {
    "json": {
      "id": "Stop 2",
      "lat": 41.74619,
      "lon": -81.26962,
      "demand": 142,
      "service_minutes": 20,
      "window_open": "10:15",
      "window_close": "13:15"
    }
  },
  {
    "json": {
      "id": "Stop 3",
      "lat": 41.70138,
      "lon": -81.36113,
      "demand": 20,
      "service_minutes": 20,
      "window_open": "11:45",
      "window_close": "14:45"
    }
  }
]
```

Node settings: **Optimize**, depot latitude `41.49837` / longitude `-81.65938`,
Departure Time `08:00`, Stop ID `{{ $json.id }}`, Stop Latitude `{{ $json.lat }}`,
Stop Longitude `{{ $json.lon }}`, Stop Fields mapped from `demand`, `service_minutes`,
`window_open` and `window_close`, one vehicle **Van 1** (capacity 250, driver Ana,
email ana@example.com), Search Seconds 10, Output **One Item per Route**.

Output: one item for the one route (from a real run; the two links are shortened here):

```json
[
  {
    "json": {
      "route": 1,
      "vehicle": "Van 1",
      "driver": "Ana",
      "driver_email": "ana@example.com",
      "stop_count": 3,
      "leave_depot": "12:04",
      "back_at_depot": "14:45",
      "route_minutes": 161,
      "load": 208,
      "driver_link": "https://routing.kindoflost.com/driver#...",
      "google_maps": [
        "https://www.google.com/maps/dir/?api=1&origin=41.49837,-81.65938&..."
      ],
      "departure_note": "Leaves at 12:04, not when the depot opens (08:00), because of the time windows at ...",
      "sequence": [
        {
          "n": 1,
          "stop": "Stop 1",
          "arrive": "12:45",
          "load_so_far": 46
        },
        {
          "n": 2,
          "stop": "Stop 2",
          "arrive": "13:13",
          "load_so_far": 188
        },
        {
          "n": 3,
          "stop": "Stop 3",
          "arrive": "13:49",
          "load_so_far": 208
        }
      ],
      "totals": {
        "vehicles_used": 1,
        "vehicles_available": 1,
        "stops_served": 3,
        "stops_unserved": 0,
        "route_minutes_total": 161
      },
      "unserved": [],
      "warnings": [],
      "quality": "Best routes found by OR-Tools guided local search in the time allowed; good, but not proven optimal.",
      "stopped_because": "search time limit reached",
      "solve_seconds": 11.8
    }
  }
]
```

Pick **One Item per Stop** instead to get one item per stop with its arrival time,
ready for a Gmail, Twilio or Google Sheets node.

## Limits

Per Optimize run: **100 stops**, **50 addresses to geocode** (stops given by
latitude/longitude do not count), **25 vehicles**, one depot, deliveries only,
one trip per vehicle. The node checks these before sending.

The service is free and shared, so it also limits use:

- About **120 requests per minute** per IP address (HTTP 429).
- **20 optimizations per IP address in any 10 minutes** (Get Result and Check
  Request do not count).
- It solves **one problem at a time**. If another solve is running, the node
  waits and retries (up to 3 times, within *Max Wait Seconds*; turn off with
  *Retry When Busy*). Run optimizations one after another, never in parallel,
  and put all vehicles in one run.

Each of these produces an error message that says which limit was hit and what to do.

## Example workflow

[`examples/example-workflow.json`](examples/example-workflow.json): Manual
Trigger → Code node with 6 stops (latitude/longitude, demand, service minutes,
time windows) → Fleet Route Optimizer with 2 vans of capacity 250. Import it in
n8n with *Import from File*. With these numbers one stop is left unserved and
the output explains why (the vans cannot carry everything).

## Compatibility

Built and linted with `@n8n/node-cli` 0.58 against `n8n-workflow` 2.x. Node.js 20.15 or later.

## Privacy

Stops, depot and driver names are sent to `routing.kindoflost.com` to be solved.
Addresses go to public geocoders (US Census, OpenStreetMap) and coordinates to a
public road-routing server (OSRM). Driver phone numbers and emails never leave
your n8n instance. See the service's [privacy page](https://routing.kindoflost.com/privacy).

## Resources

- [Fleet Route Optimizer web version](https://routing.kindoflost.com)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE.md)
