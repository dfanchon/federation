# CloudFlare Worker Compatibility Guide for Apollo Gateway

This guide explains how to make Apollo Gateway compatible with CloudFlare Workers by replacing Node.js-specific HTTP libraries with CloudFlare Worker-compatible alternatives.

## Problem

Apollo Gateway currently uses Node.js-specific HTTP libraries that are not supported in CloudFlare Workers:

1. **`make-fetch-happen`** - Node.js HTTP client with advanced features
2. **`node-fetch`** - Node.js implementation of the Fetch API
3. **`https` module** - Node.js built-in HTTPS module

CloudFlare Workers provide a global `fetch` API that follows the Web Standards, but Apollo Gateway's current implementation doesn't use it.

## Solution Overview

Replace Node.js-specific HTTP implementations with CloudFlare Worker-compatible alternatives:

### 1. Create CloudFlare Worker Compatible Data Source

Create a new file `src/datasources/CloudFlareWorkerRemoteGraphQLDataSource.ts`:

```typescript
import { isObject } from '../utilities/predicates';
import { GraphQLDataSource, GraphQLDataSourceProcessOptions, GraphQLDataSourceRequestKind } from './types';
import { createHash } from '@apollo/utils.createhash';
import { ResponsePath } from '@apollo/query-planner';
import { parseCacheControlHeader } from './parseCacheControlHeader';
import { Fetcher, FetcherRequestInit, FetcherResponse } from '@apollo/utils.fetcher';
import { GraphQLError, GraphQLErrorExtensions } from 'graphql';
import { GatewayCacheHint, GatewayCachePolicy, GatewayGraphQLRequest, GatewayGraphQLRequestContext, GatewayGraphQLResponse } from '@apollo/server-gateway-interface';

// CloudFlare Worker compatible fetch wrapper
const createCloudFlareWorkerFetcher = (): Fetcher => {
  return async (url: string, init?: FetcherRequestInit): Promise<FetcherResponse> => {
    // Use the global fetch API available in CloudFlare Workers
    const response = await fetch(url, init);
    return response as FetcherResponse;
  };
};

export class CloudFlareWorkerRemoteGraphQLDataSource<
  TContext extends Record<string, any> = Record<string, any>,
> implements GraphQLDataSource<TContext>
{
  fetcher: Fetcher;

  constructor(
    config?: Partial<CloudFlareWorkerRemoteGraphQLDataSource<TContext>> &
      object &
      ThisType<CloudFlareWorkerRemoteGraphQLDataSource<TContext>>,
  ) {
    // Use CloudFlare Worker compatible fetcher instead of make-fetch-happen
    this.fetcher = createCloudFlareWorkerFetcher();
    
    if (config) {
      return Object.assign(this, config);
    }
  }

  url!: string;
  apq: boolean = false;
  honorSubgraphCacheControlHeader: boolean = true;

  async process(
    options: GraphQLDataSourceProcessOptions<TContext>,
  ): Promise<GatewayGraphQLResponse> {
    const { request, context: originalContext } = options;
    const pathInIncomingRequest =
      options.kind === GraphQLDataSourceRequestKind.INCOMING_OPERATION
        ? options.pathInIncomingRequest
        : undefined;

    const context = originalContext as TContext;

    // Use CloudFlare Worker's global Headers constructor
    const headers = new Headers();
    if (request.http?.headers) {
      for (const [name, value] of request.http.headers) {
        headers.append(name, value);
      }
    }
    headers.set('Content-Type', 'application/json');

    request.http = {
      method: 'POST',
      url: this.url,
      headers,
    };

    if (this.willSendRequest) {
      await this.willSendRequest(options);
    }

    if (!request.query) {
      throw new Error('Missing query');
    }

    const { query, ...requestWithoutQuery } = request;

    const overallCachePolicy =
      this.honorSubgraphCacheControlHeader &&
      options.kind === GraphQLDataSourceRequestKind.INCOMING_OPERATION &&
      options.incomingRequestContext.overallCachePolicy &&
      'restrict' in options.incomingRequestContext.overallCachePolicy
        ? options.incomingRequestContext.overallCachePolicy
        : null;

    if (this.apq) {
      const apqHash = createHash('sha256').update(request.query).digest('hex');

      requestWithoutQuery.extensions = {
        ...request.extensions,
        persistedQuery: {
          version: 1,
          sha256Hash: apqHash,
        },
      };

      const apqOptimisticResponse = await this.sendRequest(
        requestWithoutQuery,
        context,
      );

      if (
        !apqOptimisticResponse.errors ||
        !apqOptimisticResponse.errors.find(
          (error) => error.message === 'PersistedQueryNotFound',
        )
      ) {
        return this.respond({
          response: apqOptimisticResponse,
          request: requestWithoutQuery,
          context,
          overallCachePolicy,
          pathInIncomingRequest
        });
      }
    }

    const requestWithQuery: GatewayGraphQLRequest = {
      query,
      ...requestWithoutQuery,
    };
    const response = await this.sendRequest(requestWithQuery, context);
    return this.respond({
      response,
      request: requestWithQuery,
      context,
      overallCachePolicy,
      pathInIncomingRequest
    });
  }

  private async sendRequest(
    request: GatewayGraphQLRequest,
    context: TContext,
  ): Promise<GatewayGraphQLResponse> {
    if (!request.http) {
      throw new Error("Internal error: Only 'http' requests are supported.");
    }

    const { http, ...requestWithoutHttp } = request;
    const stringifiedRequestWithoutHttp = JSON.stringify(requestWithoutHttp);
    const requestInit: FetcherRequestInit = {
      method: http.method,
      headers: Object.fromEntries(http.headers),
      body: stringifiedRequestWithoutHttp,
    };

    // Use CloudFlare Worker's global Request constructor
    const fetchRequest = new Request(http.url, requestInit);

    let fetchResponse: FetcherResponse | undefined;

    try {
      fetchResponse = await this.fetcher(http.url, requestInit);

      if (!fetchResponse.ok) {
        throw await this.errorFromResponse(fetchResponse);
      }

      const body = await this.parseBody(fetchResponse, fetchRequest, context);

      if (!isObject(body)) {
        throw new Error(`Expected JSON response body, but received: ${body}`);
      }

      return {
        ...body,
        http: fetchResponse,
      };
    } catch (error) {
      this.didEncounterError(error, fetchRequest, fetchResponse, context, request);
      throw error;
    }
  }

  public willSendRequest?(
    options: GraphQLDataSourceProcessOptions<TContext>,
  ): void | Promise<void>;

  private async respond({
    response,
    request,
    context,
    overallCachePolicy,
    pathInIncomingRequest
  }: {
    response: GatewayGraphQLResponse;
    request: GatewayGraphQLRequest;
    context: TContext;
    overallCachePolicy: GatewayCachePolicy | null;
    pathInIncomingRequest?: ResponsePath
  }): Promise<GatewayGraphQLResponse> {
    const processedResponse =
      typeof this.didReceiveResponse === 'function'
        ? await this.didReceiveResponse({ response, request, context, pathInIncomingRequest })
        : response;

    if (overallCachePolicy) {
      const parsed = parseCacheControlHeader(
        response.http?.headers.get('cache-control'),
      );

      const hint: GatewayCacheHint = { maxAge: 0 };
      const maxAge = parsed['max-age'];
      if (typeof maxAge === 'string' && maxAge.match(/^[0-9]+$/)) {
        hint.maxAge = +maxAge;
      }
      if (parsed['private'] === true) {
        hint.scope = 'PRIVATE';
      }
      if (parsed['public'] === true) {
        hint.scope = 'PUBLIC';
      }
      overallCachePolicy.restrict(hint);
    }

    return processedResponse;
  }

  public didReceiveResponse?(
    requestContext: Required<
      Pick<GatewayGraphQLRequestContext<TContext>, 'request' | 'response' | 'context'>
    > & { pathInIncomingRequest?: ResponsePath }
  ): GatewayGraphQLResponse | Promise<GatewayGraphQLResponse>;

  public didEncounterError(
    error: Error,
    _fetchRequest: Request,
    _fetchResponse?: FetcherResponse,
    _context?: TContext,
    _request?: GatewayGraphQLRequest,
  ) {
    throw error;
  }

  public parseBody(
    fetchResponse: FetcherResponse,
    _fetchRequest?: Request,
    _context?: TContext,
  ): Promise<object | string> {
    const contentType = fetchResponse.headers.get('Content-Type');
    if (
      contentType &&
      (contentType.startsWith('application/json') ||
        contentType.startsWith('application/graphql-response+json'))
    ) {
      return fetchResponse.json();
    } else {
      return fetchResponse.text();
    }
  }

  public async errorFromResponse(response: FetcherResponse) {
    const body = await this.parseBody(response);

    const extensions: GraphQLErrorExtensions = {
      response: {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        body,
      },
    };

    if (response.status === 401) {
      extensions.code = 'UNAUTHENTICATED';
    } else if (response.status === 403) {
      extensions.code = 'FORBIDDEN';
    }

    return new GraphQLError(`${response.status}: ${response.statusText}`, {
      extensions,
    });
  }
}
```

### 2. Create CloudFlare Worker Compatible Uplink Manager

For the UplinkSupergraphManager, create `src/supergraphManagers/CloudFlareWorkerUplinkSupergraphManager.ts`:

```typescript
import type { Logger } from '@apollo/utils.logger';
import type { Fetcher } from '@apollo/utils.fetcher';
import resolvable, { Resolvable } from '@josephg/resolvable';
import { SupergraphManager, SupergraphSdlHookOptions } from '../../config';
import {
  SubgraphHealthCheckFunction,
  SupergraphSdlUpdateFunction,
} from '../..';
import { getDefaultLogger } from '../../logger';
import { loadSupergraphSdlFromUplinks } from '../UplinkSupergraphManager/loadSupergraphSdlFromStorage';

// CloudFlare Worker compatible fetcher
const createCloudFlareWorkerFetcher = (): Fetcher => {
  return async (url: string, init?: any): Promise<any> => {
    return await fetch(url, init);
  };
};

export class CloudFlareWorkerUplinkSupergraphManager implements SupergraphManager {
  // ... copy implementation from UplinkSupergraphManager but replace:
  // - makeFetchHappen.defaults() with createCloudFlareWorkerFetcher()
  // - Remove Node.js specific configurations like maxSockets, retry, etc.
}
```

### 3. Usage in CloudFlare Workers

```typescript
import { ApolloGateway } from '@apollo/gateway';
import { CloudFlareWorkerRemoteGraphQLDataSource } from '@apollo/gateway/dist/datasources/CloudFlareWorkerRemoteGraphQLDataSource';

const gateway = new ApolloGateway({
  supergraphSdl: `
    # Your supergraph SDL here
  `,
  buildService({ url }) {
    return new CloudFlareWorkerRemoteGraphQLDataSource({
      url,
      // CloudFlare Worker specific configurations
    });
  },
});

// In your CloudFlare Worker
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const server = new ApolloServer({
      gateway,
      // ... other Apollo Server configurations
    });

    return server.executeHTTPGraphQLRequest({
      httpGraphQLRequest: {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
        search: new URL(request.url).search,
      },
      context: async () => ({
        // Your context
      }),
    });
  },
};
```

## Key Changes Required

### 1. Replace HTTP Libraries

| Original (Node.js) | CloudFlare Worker Alternative |
|-------------------|------------------------------|
| `make-fetch-happen` | `globalThis.fetch` |
| `node-fetch` Headers | `globalThis.Headers` |
| `node-fetch` Request | `globalThis.Request` |

### 2. Remove Node.js Specific Configurations

Remove these configurations that don't apply to CloudFlare Workers:
- `maxSockets: Infinity`
- `retry: false`
- HTTP Agent configurations
- Socket pooling options

### 3. Update Package Dependencies

For CloudFlare Worker builds, you may need to:
- Exclude Node.js specific dependencies
- Use polyfills for missing Node.js APIs
- Configure bundler to replace Node.js modules

## Testing

1. **Unit Tests**: Ensure all HTTP requests work with the global fetch API
2. **Integration Tests**: Test with actual CloudFlare Worker runtime
3. **Performance Tests**: Compare performance with Node.js version

## Limitations

1. **No HTTP Agent Configuration**: CloudFlare Workers don't support HTTP agent configurations
2. **No Socket Pooling**: Connection pooling is handled by CloudFlare's infrastructure
3. **Request Timeout**: Use CloudFlare Worker's built-in timeout mechanisms
4. **Retry Logic**: Implement custom retry logic if needed

## Migration Steps

1. Create the CloudFlare Worker compatible data sources
2. Update your gateway configuration to use the new data sources
3. Test thoroughly in CloudFlare Worker environment
4. Deploy and monitor performance

This approach maintains full compatibility with Apollo Gateway's features while making it work in CloudFlare Workers' runtime environment. 