import got, { HTTPError, OptionsOfJSONResponseBody } from 'got';

export function isHTTPError(err: unknown): err is HTTPError {
  return err instanceof HTTPError;
}

const baseOptions: OptionsOfJSONResponseBody = {
  responseType: 'json',
  throwHttpErrors: true,
  retry: { limit: 0 },
  timeout: { request: 60_000 },
};

export async function gotGet<T = unknown>(
  url: string,
  options: Partial<OptionsOfJSONResponseBody> = {},
): Promise<T> {
  const res = await got.get(url, { ...baseOptions, ...options });
  return res.body as T;
}

export async function gotPost<T = unknown>(
  url: string,
  body?: unknown,
  options: Partial<OptionsOfJSONResponseBody> = {},
): Promise<T> {
  const res = await got.post(url, {
    ...baseOptions,
    ...options,
    json: body as Record<string, unknown>,
  });
  return res.body as T;
}

export async function gotPut<T = unknown>(
  url: string,
  body?: unknown,
  options: Partial<OptionsOfJSONResponseBody> = {},
): Promise<T> {
  const res = await got.put(url, {
    ...baseOptions,
    ...options,
    json: body as Record<string, unknown>,
  });
  return res.body as T;
}

export async function gotPatch<T = unknown>(
  url: string,
  body?: unknown,
  options: Partial<OptionsOfJSONResponseBody> = {},
): Promise<T> {
  const res = await got.patch(url, {
    ...baseOptions,
    ...options,
    json: body as Record<string, unknown>,
  });
  return res.body as T;
}
