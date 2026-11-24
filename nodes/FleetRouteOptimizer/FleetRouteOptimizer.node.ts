import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import {
	buildOptimizeArgs,
	describeServerError,
	formatSolved,
	isBlank,
	MAX_SEARCH_SECONDS,
	MAX_VEHICLES,
	toNumber,
	toTime,
	validateOptimizeInput,
	type DepotInput,
	type OptimizeInput,
	type StopInput,
	type VehicleInput,
} from './helpers';
import { callService, MAX_SERVER_WAIT, type ServiceResult } from './transport';

const showOptimize = { show: { resource: ['route'], operation: ['optimizeRoutes'] } };

export class FleetRouteOptimizer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Fleet Route Optimizer',
		name: 'fleetRouteOptimizer',
		icon: { light: 'file:fleetRouteOptimizer.svg', dark: 'file:fleetRouteOptimizer.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Plan delivery routes for one or more vehicles with Google OR-Tools (free, no account)',
		defaults: {
			name: 'Fleet Route Optimizer',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Route', value: 'route' }],
				default: 'route',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['route'] } },
				options: [
					{
						name: 'Check Request',
						value: 'checkRequest',
						description: 'Check in plain words whether a routing problem fits the service',
						action: 'Check a routing request',
					},
					{
						name: 'Get Result',
						value: 'getResult',
						description: 'Get the result of an optimization started earlier, by job ID',
						action: 'Get a route result',
					},
					{
						name: 'Optimize',
						value: 'optimizeRoutes',
						description:
							'Plan routes from one depot: every input item is one stop, all items are solved together',
						action: 'Optimize routes',
					},
				],
				default: 'optimizeRoutes',
			},

			// ---------------------------------------------------------- Optimize: depot
			{
				displayName:
					'Each input item is one stop. All items are sent together as one routing problem (up to 100 stops, 50 of them by address, 25 vehicles). The service is free and needs no account.',
				name: 'optimizeNotice',
				type: 'notice',
				default: '',
				displayOptions: showOptimize,
			},
			{
				displayName: 'Depot Location',
				name: 'depotLocationType',
				type: 'options',
				options: [
					{ name: 'Address', value: 'address' },
					{ name: 'Latitude and Longitude', value: 'coordinates' },
				],
				default: 'address',
				description: 'Where every vehicle starts and ends',
				displayOptions: showOptimize,
			},
			{
				displayName: 'Depot Address',
				name: 'depotAddress',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. 1 Main St, Springfield, IL 62701',
				description: 'Street address with city and ZIP/postcode',
				displayOptions: {
					show: { ...showOptimize.show, depotLocationType: ['address'] },
				},
			},
			{
				displayName: 'Depot Latitude',
				name: 'depotLat',
				type: 'number',
				typeOptions: { numberPrecision: 6, minValue: -90, maxValue: 90 },
				default: 0,
				required: true,
				displayOptions: {
					show: { ...showOptimize.show, depotLocationType: ['coordinates'] },
				},
			},
			{
				displayName: 'Depot Longitude',
				name: 'depotLon',
				type: 'number',
				typeOptions: { numberPrecision: 6, minValue: -180, maxValue: 180 },
				default: 0,
				required: true,
				displayOptions: {
					show: { ...showOptimize.show, depotLocationType: ['coordinates'] },
				},
			},
			{
				displayName: 'Departure Time',
				name: 'departureTime',
				type: 'string',
				default: '08:00',
				placeholder: 'e.g. 08:00',
				description:
					"Earliest time vehicles leave the depot, as 'HH:MM' (24 h), '8:30 AM' or minutes after midnight. Leave empty for 00:00.",
				displayOptions: showOptimize,
			},

			// ---------------------------------------------------------- Optimize: stops
			{
				displayName: 'Stop Location',
				name: 'stopLocationType',
				type: 'options',
				options: [
					{ name: 'Address', value: 'address' },
					{ name: 'Latitude and Longitude', value: 'coordinates' },
				],
				default: 'address',
				description:
					'How each stop is located. Latitude and longitude is faster and never fails to geocode.',
				displayOptions: showOptimize,
			},
			{
				displayName: 'Stop ID',
				name: 'stopId',
				type: 'string',
				default: '={{ $json.id }}',
				description:
					"Your label for the stop (customer name, order number). Must be unique. Empty = 'stop N'.",
				displayOptions: showOptimize,
			},
			{
				displayName: 'Stop Address',
				name: 'stopAddress',
				type: 'string',
				default: '={{ $json.address }}',
				description: 'Street address with city and ZIP/postcode',
				displayOptions: {
					show: { ...showOptimize.show, stopLocationType: ['address'] },
				},
			},
			{
				displayName: 'Stop Latitude',
				name: 'stopLat',
				type: 'string',
				default: '={{ $json.lat }}',
				description: 'Latitude in decimal degrees',
				displayOptions: {
					show: { ...showOptimize.show, stopLocationType: ['coordinates'] },
				},
			},
			{
				displayName: 'Stop Longitude',
				name: 'stopLon',
				type: 'string',
				default: '={{ $json.lon }}',
				description: 'Longitude in decimal degrees',
				displayOptions: {
					show: { ...showOptimize.show, stopLocationType: ['coordinates'] },
				},
			},
			{
				displayName: 'Stop Fields',
				name: 'stopFields',
				type: 'collection',
				placeholder: 'Add Stop Field',
				default: {},
				description: 'Optional per-stop values, usually mapped from the input item',
				displayOptions: showOptimize,
				options: [
					{
						displayName: 'Demand',
						name: 'demand',
						type: 'string',
						default: '={{ $json.demand }}',
						description:
							'Quantity delivered at this stop (boxes, kg...). Counts against vehicle capacity.',
					},
					{
						displayName: 'Service Minutes',
						name: 'serviceMinutes',
						type: 'string',
						default: '={{ $json.service_minutes }}',
						description: 'Minutes spent at the stop',
					},
					{
						displayName: 'Time Window Close',
						name: 'windowClose',
						type: 'string',
						default: '={{ $json.window_close }}',
						description: "Latest arrival, e.g. '12:00' or '5:00 PM'",
					},
					{
						displayName: 'Time Window Open',
						name: 'windowOpen',
						type: 'string',
						default: '={{ $json.window_open }}',
						description: "Earliest arrival, e.g. '09:00' or '9:00 AM'",
					},
				],
			},

			// ---------------------------------------------------------- Optimize: vehicles
			{
				displayName: 'Vehicles',
				name: 'vehicleMode',
				type: 'options',
				options: [
					{
						name: 'Number of Identical Vehicles',
						value: 'count',
						description: 'All vehicles share one capacity',
					},
					{
						name: 'List of Vehicles',
						value: 'list',
						description: 'Name, capacity and driver per vehicle',
					},
				],
				default: 'count',
				displayOptions: showOptimize,
			},
			{
				displayName: 'Number of Vehicles',
				name: 'vehicleCount',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: MAX_VEHICLES },
				default: 1,
				displayOptions: { show: { ...showOptimize.show, vehicleMode: ['count'] } },
			},
			{
				displayName: 'Capacity per Vehicle',
				name: 'vehicleCapacity',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 0,
				description: 'Maximum total demand one vehicle can carry. 0 = unlimited.',
				displayOptions: { show: { ...showOptimize.show, vehicleMode: ['count'] } },
			},
			{
				displayName: 'Vehicle List',
				name: 'vehicleList',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Vehicle',
				default: {},
				displayOptions: { show: { ...showOptimize.show, vehicleMode: ['list'] } },
				options: [
					{
						displayName: 'Vehicle',
						name: 'vehicle',
						values: [
							{
								displayName: 'Capacity',
								name: 'capacity',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 0,
								description: 'Maximum total demand. 0 = unlimited.',
							},
							{
								displayName: 'Driver Email',
								name: 'driverEmail',
								type: 'string',
								placeholder: 'name@email.com',
								default: '',
								description:
									"Not sent to the service. Copied onto this vehicle's output so a later node can email the driver link.",
							},
							{
								displayName: 'Driver Name',
								name: 'driverName',
								type: 'string',
								default: '',
								description: "Shown on the route and on the driver's phone page",
							},
							{
								displayName: 'Driver Phone',
								name: 'driverPhone',
								type: 'string',
								default: '',
								description:
									"Not sent to the service. Copied onto this vehicle's output so a later node can text the driver link.",
							},
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'e.g. Van 1',
								description: "Unique vehicle name. Empty = 'Vehicle N'.",
							},
						],
					},
				],
			},
			{
				displayName: 'Country',
				name: 'country',
				type: 'options',
				options: [
					{ name: 'United States', value: 'US' },
					{ name: 'Other', value: 'OTHER' },
				],
				default: 'US',
				description:
					'Which geocoder reads the addresses: US Census then OpenStreetMap (United States), or OpenStreetMap (Other)',
				displayOptions: showOptimize,
			},
			{
				displayName: 'Search Seconds',
				name: 'searchSeconds',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: MAX_SEARCH_SECONDS },
				default: 30,
				description:
					'How long the solver searches for better routes (it stops earlier after 20 seconds without improvement)',
				displayOptions: showOptimize,
			},
			{
				displayName: 'Wait for Result',
				name: 'waitForResult',
				type: 'boolean',
				default: true,
				description:
					'Whether to wait until the routes are ready. If off, the node returns a job ID at once; use Get Result later (results are kept 15 minutes).',
				displayOptions: showOptimize,
			},
			{
				displayName: 'Output',
				name: 'outputMode',
				type: 'options',
				options: [
					{
						name: 'One Item per Route',
						value: 'route',
						description: 'Each item is a vehicle route with its stop list and driver link',
					},
					{
						name: 'One Item per Stop',
						value: 'stop',
						description:
							'Each item is a stop with its route number, sequence and arrival time; unserved stops come last',
					},
					{
						name: 'Raw Result',
						value: 'raw',
						description: 'One item with the full result as the service returns it',
					},
				],
				default: 'route',
				displayOptions: {
					show: { resource: ['route'], operation: ['optimizeRoutes', 'getResult'] },
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: showOptimize,
				options: [
					{
						displayName: 'Depot Closes At',
						name: 'depotClose',
						type: 'string',
						default: '',
						placeholder: 'e.g. 18:00',
						description: 'Latest time vehicles must be back at the depot',
					},
					{
						displayName: 'Goal',
						name: 'goal',
						type: 'string',
						default: '',
						placeholder: "e.g. plan tomorrow's deliveries for 3 vans",
						description:
							'One sentence on what you are trying to do. Optional; helps the service improve.',
					},
					{
						displayName: 'Max Wait Seconds',
						name: 'maxWaitSeconds',
						type: 'number',
						typeOptions: { minValue: 10, maxValue: 900 },
						default: 300,
						description:
							'How long the node keeps waiting for the result (and for a busy server) before it returns the job ID instead',
					},
					{
						displayName: 'Retry When Busy',
						name: 'retryWhenBusy',
						type: 'boolean',
						default: true,
						description:
							'Whether to wait and retry (up to 3 times, within Max Wait Seconds) when the free server is solving another problem',
					},
					{
						displayName: 'Skip Addresses Not Found',
						name: 'skipUnfoundAddresses',
						type: 'boolean',
						default: false,
						description:
							'Whether to plan routes for the other stops when some addresses cannot be found (they are listed as unserved). Off = the run fails and names them.',
					},
				],
			},

			// ---------------------------------------------------------- Get Result
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				required: true,
				default: '={{ $json.job_id }}',
				description: 'The job_id returned by the Optimize operation with Wait for Result off',
				displayOptions: { show: { resource: ['route'], operation: ['getResult'] } },
			},
			{
				displayName: 'Wait for Result',
				name: 'waitForResultGet',
				type: 'boolean',
				default: true,
				description:
					'Whether to keep polling until the job finishes (up to 5 minutes). If off, the node asks once and returns status running if it is not done.',
				displayOptions: { show: { resource: ['route'], operation: ['getResult'] } },
			},

			// ---------------------------------------------------------- Check Request
			{
				displayName: 'Description',
				name: 'checkDescription',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				placeholder: 'e.g. 3 vans, 60 deliveries with time windows from one warehouse',
				description:
					'The routing problem in a sentence or two. Returns whether the service supports it and, if not, the closest thing it can do. No solve, no rate-limit cost.',
				displayOptions: { show: { resource: ['route'], operation: ['checkRequest'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;

		if (operation === 'optimizeRoutes') {
			return [await optimizeRoutes(this, items)];
		}

		const returnData: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				if (operation === 'getResult') {
					const jobId = String(this.getNodeParameter('jobId', i) ?? '').trim();
					if (!jobId) {
						throw new NodeOperationError(this.getNode(), 'Job ID is empty', { itemIndex: i });
					}
					const wait = this.getNodeParameter('waitForResultGet', i, true) as boolean;
					const mode = this.getNodeParameter('outputMode', i, 'route') as 'route' | 'stop' | 'raw';
					const res = await pollResult(this, jobId, wait ? 300 : 0, i);
					returnData.push(...toItems(this, res, mode, [], [], [], i, jobId));
				} else if (operation === 'checkRequest') {
					const description = String(this.getNodeParameter('checkDescription', i) ?? '').trim();
					if (!description) {
						throw new NodeOperationError(this.getNode(), 'Description is empty', { itemIndex: i });
					}
					const res = await callService(this, 'check', { description }, i);
					if (res.isError) throwServerError(this, res.data, i);
					returnData.push({ json: res.data, pairedItem: { item: i } });
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [returnData];
	}
}

// ------------------------------------------------------------------ helpers

async function optimizeRoutes(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const allPaired = items.map((_, i) => ({ item: i }));
	try {
		const input = readOptimizeInput(ctx, items);
		const problems = validateOptimizeInput(input);
		if (problems.length) {
			throw new NodeOperationError(ctx.getNode(), 'The routing input is not valid', {
				description:
					problems.slice(0, 10).join('\n') +
					(problems.length > 10 ? `\n...and ${problems.length - 10} more` : ''),
			});
		}
		const waitForResult = ctx.getNodeParameter('waitForResult', 0, true) as boolean;
		const options = ctx.getNodeParameter('options', 0, {}) as IDataObject;
		const maxWait = Number(options.maxWaitSeconds ?? 300);
		const retryWhenBusy = options.retryWhenBusy !== false;
		const mode = ctx.getNodeParameter('outputMode', 0, 'route') as 'route' | 'stop' | 'raw';

		const started = Date.now();
		const firstWait = waitForResult ? MAX_SERVER_WAIT : 0;
		let data: IDataObject;
		// Each retry counts toward the 20-solves-per-10-minutes limit, so retry at most 3 times.
		let busyRetries = 0;
		for (;;) {
			const res: ServiceResult = await callService(
				ctx,
				'optimize',
				buildOptimizeArgs(input, firstWait),
				0,
			);
			data = res.data;
			if (!res.isError && data.status === 'running' && waitForResult) {
				const left = Math.max(0, maxWait - (Date.now() - started) / 1000);
				// A job that could not get the solver slot also finishes as 'busy'.
				data = await pollResult(ctx, String(data.job_id), left, 0, false);
			}
			if (!(data.status === 'busy' && waitForResult && retryWhenBusy && busyRetries < 3)) break;
			busyRetries++;
			const retryS = Math.max(5, Number(data.retry_after_seconds) || 30);
			if ((Date.now() - started) / 1000 + retryS > maxWait) break;
			await sleep(retryS * 1000);
		}
		if (data.status !== 'running' && data.status !== 'solved') throwServerError(ctx, data, 0);
		const jsonIn = items.map((it) => it.json);
		return toItems(ctx, data, mode, input.stops, input.vehicles, jsonIn, 0, undefined, allPaired);
	} catch (error) {
		if (ctx.continueOnFail()) {
			return [{ json: { error: (error as Error).message }, pairedItem: allPaired }];
		}
		throw new NodeOperationError(ctx.getNode(), error as Error);
	}
}

function readOptimizeInput(ctx: IExecuteFunctions, items: INodeExecutionData[]): OptimizeInput {
	const depotType = ctx.getNodeParameter('depotLocationType', 0) as string;
	const options = ctx.getNodeParameter('options', 0, {}) as IDataObject;
	const depot: DepotInput = {
		open: toTime(ctx.getNodeParameter('departureTime', 0, '')),
		close: toTime(options.depotClose),
	};
	if (depotType === 'coordinates') {
		depot.lat = toNumber(ctx.getNodeParameter('depotLat', 0));
		depot.lon = toNumber(ctx.getNodeParameter('depotLon', 0));
	} else {
		depot.address = String(ctx.getNodeParameter('depotAddress', 0, '') ?? '').trim();
	}

	const stopType = ctx.getNodeParameter('stopLocationType', 0) as string;
	const stops: StopInput[] = [];
	for (let i = 0; i < items.length; i++) {
		const rawId = ctx.getNodeParameter('stopId', i, '');
		const fields = ctx.getNodeParameter('stopFields', i, {}) as IDataObject;
		const stop: StopInput = {
			itemIndex: i,
			id: isBlank(rawId) ? `stop ${i + 1}` : String(rawId).trim(),
			demand: toNumber(fields.demand),
			serviceMinutes: toNumber(fields.serviceMinutes),
			windowOpen: toTime(fields.windowOpen),
			windowClose: toTime(fields.windowClose),
		};
		if (stopType === 'coordinates') {
			stop.lat = toNumber(ctx.getNodeParameter('stopLat', i, ''));
			stop.lon = toNumber(ctx.getNodeParameter('stopLon', i, ''));
		} else {
			stop.address = String(ctx.getNodeParameter('stopAddress', i, '') ?? '').trim();
		}
		stops.push(stop);
	}

	const vehicles: VehicleInput[] = [];
	if ((ctx.getNodeParameter('vehicleMode', 0) as string) === 'list') {
		const list = ctx.getNodeParameter('vehicleList.vehicle', 0, []) as IDataObject[];
		list.forEach((v, k) => {
			const cap = Number(v.capacity ?? 0);
			vehicles.push({
				id: isBlank(v.name) ? `Vehicle ${k + 1}` : String(v.name).trim(),
				capacity: cap > 0 ? cap : undefined,
				driverName: isBlank(v.driverName) ? undefined : String(v.driverName).trim(),
				driverPhone: isBlank(v.driverPhone) ? undefined : String(v.driverPhone).trim(),
				driverEmail: isBlank(v.driverEmail) ? undefined : String(v.driverEmail).trim(),
			});
		});
	} else {
		const count = Math.floor(Number(ctx.getNodeParameter('vehicleCount', 0, 1)));
		const cap = Number(ctx.getNodeParameter('vehicleCapacity', 0, 0));
		for (let k = 1; k <= count; k++) {
			vehicles.push({ id: `Vehicle ${k}`, capacity: cap > 0 ? cap : undefined });
		}
	}

	return {
		depot,
		stops,
		vehicles,
		country: (ctx.getNodeParameter('country', 0, 'US') as string) === 'OTHER' ? 'OTHER' : 'US',
		searchSeconds: Number(ctx.getNodeParameter('searchSeconds', 0, 30)),
		skipUnfoundAddresses: options.skipUnfoundAddresses === true,
		goal: isBlank(options.goal) ? undefined : String(options.goal),
	};
}

/**
 * Long-poll the job's result until the job is done or `budgetS` runs out.
 * Returns the last result (status 'running' if the budget ran out).
 */
async function pollResult(
	ctx: IExecuteFunctions,
	jobId: string,
	budgetS: number,
	itemIndex: number,
	throwOnError = true,
): Promise<IDataObject> {
	const started = Date.now();
	for (;;) {
		const left = budgetS - (Date.now() - started) / 1000;
		const wait = Math.max(0, Math.min(MAX_SERVER_WAIT, Math.floor(left)));
		const t0 = Date.now();
		const res = await callService(
			ctx,
			'getResult',
			{ job_id: jobId, wait_seconds: wait },
			itemIndex,
		);
		if (res.isError) {
			if (throwOnError) throwServerError(ctx, res.data, itemIndex);
			return res.data;
		}
		if (res.data.status !== 'running') return res.data;
		if ((Date.now() - started) / 1000 >= budgetS - 1) return { ...res.data, job_id: jobId };
		// The server answers at once when its waiting slots are full; do not hammer it.
		if (Date.now() - t0 < 5000) await sleep(5000);
	}
}

function toItems(
	ctx: IExecuteFunctions,
	data: IDataObject,
	mode: 'route' | 'stop' | 'raw',
	stops: StopInput[],
	vehicles: VehicleInput[],
	inputJson: IDataObject[],
	itemIndex: number,
	jobId?: string,
	paired?: Array<{ item: number }>,
): INodeExecutionData[] {
	const pairedItem = paired ?? [{ item: itemIndex }];
	if (data.status === 'running') {
		return [
			{
				json: {
					status: 'running',
					job_id: data.job_id ?? jobId,
					seconds_so_far: data.seconds_so_far,
					message:
						'Still solving. Use the Get Result operation with this job_id (results are kept 15 minutes after the solve finishes).',
				},
				pairedItem,
			},
		];
	}
	if (data.status !== 'solved') throwServerError(ctx, data, itemIndex);
	if (stops.length === 0) {
		// Get Result: the original items are not available, so pair everything with this item.
		const out = formatSolved(data, mode, [], [], []);
		return out.map((o) => ({ json: o.json, pairedItem }));
	}
	return formatSolved(data, mode, stops, vehicles, inputJson).map((o) => ({
		json: o.json,
		pairedItem: o.pairedItem.length ? o.pairedItem : pairedItem,
	}));
}

function throwServerError(ctx: IExecuteFunctions, data: IDataObject, itemIndex: number): never {
	if (data.status === 'busy') {
		const s = Number(data.retry_after_seconds) || 30;
		throw new NodeOperationError(
			ctx.getNode(),
			'The free routing server is busy with another problem',
			{
				itemIndex,
				description: `It solves one problem at a time. Try again in about ${s} seconds. Run optimizations one after another, never in parallel, and put all vehicles in one run.`,
			},
		);
	}
	const { message, description } = describeServerError(data);
	throw new NodeOperationError(ctx.getNode(), message, { itemIndex, description });
}
