import type { IDataObject, IPairedItemData } from 'n8n-workflow';

/** Service limits per optimize call (enforced by the server too). */
export const MAX_STOPS = 100;
export const MAX_GEOCODE = 50;
export const MAX_VEHICLES = 25;
export const MAX_SEARCH_SECONDS = 60;

export interface StopInput {
	/** Index of the n8n input item this stop came from. */
	itemIndex: number;
	id: string;
	address?: string;
	lat?: number;
	lon?: number;
	demand?: number;
	serviceMinutes?: number;
	windowOpen?: string;
	windowClose?: string;
}

export interface VehicleInput {
	id: string;
	capacity?: number;
	driverName?: string;
	driverPhone?: string;
	driverEmail?: string;
}

export interface DepotInput {
	address?: string;
	lat?: number;
	lon?: number;
	open?: string;
	close?: string;
}

export interface OptimizeInput {
	depot: DepotInput;
	stops: StopInput[];
	vehicles: VehicleInput[];
	country: 'US' | 'OTHER';
	searchSeconds: number;
	skipUnfoundAddresses: boolean;
	goal?: string;
}

/** Empty string, null and undefined count as "not given". */
export function isBlank(v: unknown): boolean {
	return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Parse an optional number; returns undefined when blank, NaN when not a number. */
export function toNumber(v: unknown): number | undefined {
	if (isBlank(v)) return undefined;
	const n = typeof v === 'number' ? v : Number(String(v).trim());
	return n;
}

/**
 * A clock time as the service accepts it: 'HH:MM', '8:30 AM' or minutes after
 * midnight. Returns undefined when blank.
 */
export function toTime(v: unknown): string | undefined {
	if (isBlank(v)) return undefined;
	return String(v).trim();
}

/**
 * Check the request against the service limits before sending it, so the user
 * gets a message that names the problem. Returns a list of problems (empty = ok).
 */
export function validateOptimizeInput(input: OptimizeInput): string[] {
	const problems: string[] = [];
	if (input.stops.length === 0)
		problems.push('There are no stops: connect at least one input item.');
	if (input.stops.length > MAX_STOPS) {
		problems.push(
			`Too many stops: ${input.stops.length} input items, the service handles up to ${MAX_STOPS} per run. Split them (for example with a Loop Over Items node) into runs of ${MAX_STOPS} or fewer.`,
		);
	}
	if (input.vehicles.length < 1) problems.push('At least one vehicle is needed.');
	if (input.vehicles.length > MAX_VEHICLES) {
		problems.push(
			`Too many vehicles: ${input.vehicles.length}, the service handles up to ${MAX_VEHICLES}.`,
		);
	}
	const depotHasCoords = input.depot.lat !== undefined && input.depot.lon !== undefined;
	if (!depotHasCoords && isBlank(input.depot.address)) {
		problems.push('The depot needs an address, or a latitude and longitude.');
	}
	if (depotHasCoords && !validLatLon(input.depot.lat as number, input.depot.lon as number)) {
		problems.push(
			'The depot latitude/longitude is not valid (latitude -90..90, longitude -180..180).',
		);
	}
	const seen = new Map<string, number>();
	let toGeocode = depotHasCoords ? 0 : 1;
	for (const s of input.stops) {
		const where = `Item ${s.itemIndex + 1} (stop '${s.id}')`;
		const hasCoords = s.lat !== undefined || s.lon !== undefined;
		if (hasCoords) {
			if (s.lat === undefined || s.lon === undefined || !validLatLon(s.lat, s.lon)) {
				problems.push(`${where}: latitude/longitude missing or not valid.`);
			}
		} else if (isBlank(s.address)) {
			problems.push(`${where}: no address and no latitude/longitude.`);
		} else {
			toGeocode++;
		}
		for (const [name, val] of [
			['demand', s.demand],
			['service minutes', s.serviceMinutes],
		] as Array<[string, number | undefined]>) {
			if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
				problems.push(`${where}: ${name} must be a number of 0 or more.`);
			}
		}
		const prev = seen.get(s.id);
		if (prev !== undefined) {
			problems.push(
				`${where}: the stop ID '${s.id}' is also used by item ${prev + 1}. Stop IDs must be unique so each result can be matched back to its item.`,
			);
		} else {
			seen.set(s.id, s.itemIndex);
		}
	}
	if (toGeocode > MAX_GEOCODE) {
		problems.push(
			`Too many addresses to look up: ${toGeocode} (depot included), the service geocodes up to ${MAX_GEOCODE} per run. Give latitude/longitude for some stops, or split the run.`,
		);
	}
	for (const v of input.vehicles) {
		if (v.capacity !== undefined && (!Number.isFinite(v.capacity) || v.capacity <= 0)) {
			problems.push(
				`Vehicle '${v.id}': capacity must be a positive number (leave it empty for unlimited).`,
			);
		}
	}
	const vIds = new Set<string>();
	for (const v of input.vehicles) {
		if (vIds.has(v.id))
			problems.push(`Vehicle name '${v.id}' is used twice. Vehicle names must be unique.`);
		vIds.add(v.id);
	}
	if (
		!Number.isFinite(input.searchSeconds) ||
		input.searchSeconds < 1 ||
		input.searchSeconds > MAX_SEARCH_SECONDS
	) {
		problems.push(`Search seconds must be between 1 and ${MAX_SEARCH_SECONDS}.`);
	}
	return problems;
}

function validLatLon(lat: number, lon: number): boolean {
	return (
		Number.isFinite(lat) &&
		Number.isFinite(lon) &&
		lat >= -90 &&
		lat <= 90 &&
		lon >= -180 &&
		lon <= 180
	);
}

/** Build the POST /routes body. Driver phone and email are not sent. */
export function buildOptimizeArgs(input: OptimizeInput, waitSeconds: number): IDataObject {
	const depot: IDataObject = { id: 'Depot' };
	if (input.depot.lat !== undefined && input.depot.lon !== undefined) {
		depot.lat = input.depot.lat;
		depot.lon = input.depot.lon;
	} else {
		depot.address = input.depot.address;
	}
	if (input.depot.open) depot.open = input.depot.open;
	if (input.depot.close) depot.close = input.depot.close;

	const stops: IDataObject[] = input.stops.map((s) => {
		const o: IDataObject = { id: s.id };
		if (s.lat !== undefined && s.lon !== undefined) {
			o.lat = s.lat;
			o.lon = s.lon;
		} else {
			o.address = s.address;
		}
		if (s.demand !== undefined) o.demand = s.demand;
		if (s.serviceMinutes !== undefined) o.service_minutes = s.serviceMinutes;
		if (s.windowOpen) o.window_open = s.windowOpen;
		if (s.windowClose) o.window_close = s.windowClose;
		return o;
	});

	const vehicles: IDataObject[] = input.vehicles.map((v) => {
		const o: IDataObject = { id: v.id };
		if (v.capacity !== undefined) o.capacity = v.capacity;
		if (!isBlank(v.driverName)) o.driver = v.driverName;
		return o;
	});

	const args: IDataObject = {
		depot,
		stops,
		vehicles,
		country: input.country,
		parameters: { SearchParametersTimeLimit: input.searchSeconds },
		wait_seconds: waitSeconds,
	};
	if (input.skipUnfoundAddresses) args.skip_unfound_addresses = true;
	if (!isBlank(input.goal)) args.goal = String(input.goal).slice(0, 300);
	return args;
}

/** Summary fields shared by every output item of one solve. */
function solveSummary(result: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const k of [
		'totals',
		'unserved',
		'unserved_hint',
		'warnings',
		'assumptions',
		'quality',
		'stopped_because',
		'solve_seconds',
	]) {
		if (result[k] !== undefined) out[k] = result[k];
	}
	return out;
}

function driverExtras(vehicles: VehicleInput[], vehicleId: unknown): IDataObject {
	const v = vehicles.find((x) => x.id === vehicleId);
	const o: IDataObject = {};
	if (v && !isBlank(v.driverPhone)) o.driver_phone = v.driverPhone;
	if (v && !isBlank(v.driverEmail)) o.driver_email = v.driverEmail;
	return o;
}

export interface OutputItem {
	json: IDataObject;
	pairedItem: IPairedItemData[];
}

/**
 * Turn a solved result into n8n items.
 * - 'route': one item per route that has stops, with its stop sequence and driver_link.
 * - 'stop': one item per stop (served stops in route order, then unserved stops),
 *   with the stop's original input fields under `input`.
 * - 'raw': one item with the whole result.
 */
export function formatSolved(
	result: IDataObject,
	mode: 'route' | 'stop' | 'raw',
	stops: StopInput[],
	vehicles: VehicleInput[],
	inputJson: IDataObject[],
): OutputItem[] {
	const allPaired = stops.map((s) => ({ item: s.itemIndex }));
	if (mode === 'raw') return [{ json: result, pairedItem: allPaired }];

	const byId = new Map<string, StopInput>();
	for (const s of stops) byId.set(s.id, s);
	const routes = (Array.isArray(result.routes) ? result.routes : []) as IDataObject[];
	const summary = solveSummary(result);
	const items: OutputItem[] = [];

	routes.forEach((route, idx) => {
		const sequence = (Array.isArray(route.sequence) ? route.sequence : []) as IDataObject[];
		const paired = sequence
			.map((st) => byId.get(String(st.stop)))
			.filter((s): s is StopInput => s !== undefined)
			.map((s) => ({ item: s.itemIndex }));
		const routeNumber = idx + 1;
		const extras = driverExtras(vehicles, route.vehicle);
		if (mode === 'route') {
			items.push({
				json: {
					route: routeNumber,
					vehicle: route.vehicle,
					...(route.driver !== undefined ? { driver: route.driver } : {}),
					...extras,
					stop_count: route.stops,
					leave_depot: route.leave_depot,
					back_at_depot: route.back_at_depot,
					route_minutes: route.route_minutes,
					...(route.load !== undefined ? { load: route.load } : {}),
					driver_link: route.driver_link,
					google_maps: route.google_maps,
					...(route.departure_note !== undefined ? { departure_note: route.departure_note } : {}),
					sequence,
					...summary,
				},
				pairedItem: paired.length ? paired : allPaired,
			});
			return;
		}
		sequence.forEach((st, pos) => {
			const src = byId.get(String(st.stop));
			const json: IDataObject = {
				status: 'served',
				stop: st.stop,
				route: routeNumber,
				sequence: pos + 1,
				arrival: st.arrive,
				vehicle: route.vehicle,
				...(route.driver !== undefined ? { driver: route.driver } : {}),
				...extras,
			};
			for (const k of [
				'address',
				'address_match',
				'load_so_far',
				'load2_so_far',
				'load3_so_far',
				'minutes_late',
			]) {
				if (st[k] !== undefined) json[k] = st[k];
			}
			json.leave_depot = route.leave_depot;
			json.driver_link = route.driver_link;
			if (src) json.input = inputJson[src.itemIndex];
			items.push({ json, pairedItem: src ? [{ item: src.itemIndex }] : allPaired });
		});
	});

	if (mode === 'stop') {
		const unserved = (Array.isArray(result.unserved) ? result.unserved : []) as IDataObject[];
		for (const u of unserved) {
			const src = byId.get(String(u.stop));
			const json: IDataObject = {
				status: 'unserved',
				stop: u.stop,
				route: null,
				sequence: null,
				arrival: null,
				...(u.address !== undefined ? { address: u.address } : {}),
				...(result.unserved_hint !== undefined ? { reason: result.unserved_hint } : {}),
			};
			if (src) json.input = inputJson[src.itemIndex];
			items.push({ json, pairedItem: src ? [{ item: src.itemIndex }] : allPaired });
		}
	}
	return items;
}

/** Text of a server message plus its hint, for error descriptions. */
export function describeServerError(data: IDataObject): { message: string; description?: string } {
	const raw =
		typeof data.message === 'string' && data.message ? data.message : 'The request was rejected.';
	// The service's messages name its own operations; translate them to this node's.
	const msg = raw
		.replace(/calling optimize_routes/g, 'running the Optimize operation')
		.replace(/optimize_routes/g, 'the Optimize operation')
		.replace(/get_route_result/g, 'the Get Result operation');
	const hints: string[] = [];
	for (const k of ['retry_hint', 'unserved_hint']) {
		if (typeof data[k] === 'string') hints.push(data[k] as string);
	}
	if (/too many solves from this address/i.test(msg)) {
		return {
			message: 'Rate limit: too many route optimizations from this IP address',
			description:
				'The free service allows 20 optimizations per IP address in any 10 minutes. Wait a few minutes before running again. Get Result and Check Request do not count toward this limit.',
		};
	}
	return { message: msg, description: hints.length ? hints.join(' ') : undefined };
}
