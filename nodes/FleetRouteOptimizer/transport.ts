import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/**
 * The Fleet Route Optimizer service (https://routing.kindoflost.com) is free
 * and needs no account. This file is the only place that knows its REST API
 * (JSON over HTTPS, base https://routing.kindoflost.com/api/v1):
 *
 *   POST /routes                          start a solve; 200 with the routes, or
 *                                         202 { status: 'running', job_id }
 *   GET  /routes/{job_id}?wait_seconds=N  the result of a solve (404 when expired)
 *   POST /routes/check                    { description } -> is it supported?
 *
 * Errors: 400 bad input, 404 unknown or expired job, 422 finished without
 * routes, 429 rate limit and 503 busy (both with a Retry-After header).
 */
export const API_BASE = 'https://routing.kindoflost.com/api/v1';
const CLIENT_NAME = 'n8n-nodes-fleet-route-optimizer';
const CLIENT_VERSION = '0.1.0';

/** Longest the server waits inside one call (its own cap). */
export const MAX_SERVER_WAIT = 45;

export type Operation = 'optimize' | 'getResult' | 'check';

/** Result of one call: the JSON body and whether the service reported an error. */
export interface ServiceResult {
	data: IDataObject;
	isError: boolean;
}

function request(
	op: Operation,
	args: IDataObject,
): Pick<IHttpRequestOptions, 'method' | 'url' | 'body' | 'qs'> {
	if (op === 'getResult') {
		return {
			method: 'GET',
			url: `${API_BASE}/routes/${encodeURIComponent(String(args.job_id ?? ''))}`,
			qs: { wait_seconds: Number(args.wait_seconds ?? 0) },
		};
	}
	if (op === 'check') {
		return {
			method: 'POST',
			url: `${API_BASE}/routes/check`,
			body: { description: args.description },
		};
	}
	return { method: 'POST', url: `${API_BASE}/routes`, body: args };
}

function retryAfter(headers: IDataObject | undefined, body: IDataObject | undefined): number {
	const h = headers ? Number(headers['retry-after'] ?? headers['Retry-After']) : NaN;
	if (Number.isFinite(h) && h > 0) return Math.ceil(h);
	const b = body ? Number(body.retry_after_seconds) : NaN;
	return Number.isFinite(b) && b > 0 ? Math.ceil(b) : 30;
}

/**
 * Call the service. Throws NodeApiError on transport problems (network, a
 * non-JSON answer, an unexpected HTTP status) and on the two rate limits
 * (HTTP 429). Service-level errors (bad input, expired job, no routes, busy)
 * come back with isError = true so the caller can decide what to do; a busy
 * reply always carries status 'busy' and retry_after_seconds.
 */
export async function callService(
	ctx: IExecuteFunctions,
	op: Operation,
	args: IDataObject,
	itemIndex: number,
): Promise<ServiceResult> {
	const options: IHttpRequestOptions = {
		...request(op, args),
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'X-Client': 'n8n',
			'User-Agent': `${CLIENT_NAME}/${CLIENT_VERSION}`,
		},
		json: true,
		timeout: (MAX_SERVER_WAIT + 30) * 1000,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};

	let response: { statusCode: number; headers?: IDataObject; body: unknown };
	try {
		response = (await ctx.helpers.httpRequest(options)) as {
			statusCode: number;
			headers?: IDataObject;
			body: unknown;
		};
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			itemIndex,
			message: 'Could not reach the Fleet Route Optimizer service',
			description: `The request to ${API_BASE} failed before an answer came back. Check the n8n server's internet access and try again.`,
		});
	}

	const status = response.statusCode;
	let body = response.body as IDataObject | string | undefined;
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body) as IDataObject;
		} catch {
			body = undefined;
		}
	}
	const data = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
	const wait = retryAfter(response.headers, data);

	if (status === 429) {
		const message = typeof data?.message === 'string' ? data.message : '';
		if (/too many solves/i.test(message)) {
			throw new NodeApiError(ctx.getNode(), { httpCode: '429' } as JsonObject, {
				itemIndex,
				httpCode: '429',
				message: 'Rate limit: too many route optimizations from this IP address',
				description: `The free service allows 20 optimizations per IP address in any 10 minutes. Wait about ${wait} seconds before running again. Get Result and Check Request do not count toward this limit.`,
			});
		}
		throw new NodeApiError(ctx.getNode(), { httpCode: '429' } as JsonObject, {
			itemIndex,
			httpCode: '429',
			message: 'Rate limit: too many requests to the Fleet Route Optimizer',
			description: `The free service accepts about 120 requests per minute from one IP address. Wait about ${wait} seconds, then run the workflow again. If you poll in a loop, poll less often.`,
		});
	}
	if (status === 503 && (!data || data.error === 'busy' || data.status === 'busy')) {
		// Busy (one solve at a time), or the service is restarting: both mean "retry later".
		return {
			data: {
				...(data ?? {}),
				status: 'busy',
				retry_after_seconds: wait,
				message:
					typeof data?.message === 'string'
						? data.message
						: 'The service is restarting or busy. Try again shortly.',
			},
			isError: true,
		};
	}
	if (!data) {
		throw new NodeApiError(ctx.getNode(), { httpCode: String(status) } as JsonObject, {
			itemIndex,
			httpCode: String(status),
			message: `Unexpected response from the Fleet Route Optimizer (HTTP ${status})`,
			description: 'The service did not return JSON. It may be restarting; try again in a minute.',
		});
	}
	if (status === 200 || status === 202) {
		if (Object.keys(data).length === 0) {
			throw new NodeOperationError(ctx.getNode(), 'The Fleet Route Optimizer returned no result', {
				itemIndex,
			});
		}
		return { data, isError: false };
	}
	if (status === 400 || status === 404 || status === 422) {
		return { data, isError: true };
	}
	throw new NodeApiError(ctx.getNode(), data as JsonObject, {
		itemIndex,
		httpCode: String(status),
		message: `Fleet Route Optimizer error (HTTP ${status}): ${String(data.message ?? data.error ?? 'unknown error')}`,
	});
}
