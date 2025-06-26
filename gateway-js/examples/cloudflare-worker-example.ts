/**
 * Example: Using Apollo Gateway in CloudFlare Workers
 * 
 * This example demonstrates how to use the CloudFlareWorkerRemoteGraphQLDataSource
 * to run Apollo Gateway in a CloudFlare Worker environment.
 * 
 * Note: This is an example file. In a real CloudFlare Worker project, you would:
 * 1. Install the required dependencies: @apollo/gateway, @apollo/server
 * 2. Configure your bundler to handle Node.js polyfills if needed
 * 3. Add proper TypeScript types for CloudFlare Workers
 */

// @ts-ignore - Example imports
import { ApolloGateway } from '@apollo/gateway';
// @ts-ignore - Example imports  
import { CloudFlareWorkerRemoteGraphQLDataSource } from '@apollo/gateway';
// @ts-ignore - Example imports
import { ApolloServer } from '@apollo/server';

// Example supergraph SDL (you would typically load this from Apollo Studio or a file)
const supergraphSdl = `
  schema
    @link(url: "https://specs.apollo.dev/link/v1.0")
    @link(url: "https://specs.apollo.dev/join/v0.3", for: EXECUTION)
  {
    query: Query
  }

  directive @join__enumValue(graph: join__Graph!) repeatable on ENUM_VALUE

  directive @join__field(graph: join__Graph, requires: join__FieldSet, provides: join__FieldSet, type: String, external: Boolean, override: String, usedOverridden: Boolean) repeatable on FIELD_DEFINITION | INPUT_FIELD_DEFINITION

  directive @join__graph(name: String!, url: String!) on ENUM_VALUE

  directive @join__implements(graph: join__Graph!, interface: String!) repeatable on OBJECT | INTERFACE

  directive @join__type(graph: join__Graph!, key: join__FieldSet, extension: Boolean! = false, resolvable: Boolean! = true, isInterfaceObject: Boolean! = false) repeatable on OBJECT | INTERFACE | UNION | ENUM | INPUT_OBJECT | SCALAR

  directive @join__unionMember(graph: join__Graph!, member: String!) repeatable on UNION

  directive @link(url: String, as: String, for: link__Purpose, import: [link__Import]) repeatable on SCHEMA

  scalar join__FieldSet

  enum join__Graph {
    ACCOUNTS @join__graph(name: "accounts", url: "https://accounts.example.com/graphql")
    PRODUCTS @join__graph(name: "products", url: "https://products.example.com/graphql")
  }

  scalar link__Import

  enum link__Purpose {
    SECURITY
    EXECUTION
  }

  type Query
    @join__type(graph: ACCOUNTS)
    @join__type(graph: PRODUCTS)
  {
    me: User @join__field(graph: ACCOUNTS)
    products: [Product] @join__field(graph: PRODUCTS)
  }

  type User
    @join__type(graph: ACCOUNTS, key: "id")
  {
    id: ID!
    name: String!
  }

  type Product
    @join__type(graph: PRODUCTS, key: "id")
  {
    id: ID!
    name: String!
    price: Float!
  }
`;

// Create the gateway with CloudFlare Worker compatible data sources
const gateway = new ApolloGateway({
  supergraphSdl,
  buildService({ url }) {
    return new CloudFlareWorkerRemoteGraphQLDataSource({
      url,
      // Enable APQ for better performance
      apq: true,
      // You can customize other options here
      willSendRequest({ request, context }) {
        // Add custom headers, authentication, etc.
        request.http?.headers.set('x-custom-header', 'value');
      },
    });
  },
});

// Create Apollo Server
const server = new ApolloServer({
  gateway,
  // Disable introspection and playground in production
  introspection: false,
  // Add other Apollo Server configurations as needed
});

// CloudFlare Worker interfaces (these would be provided by @cloudflare/workers-types)
interface Env {
  // Define your environment variables here
  // APOLLO_KEY?: string;
  // APOLLO_GRAPH_REF?: string;
}

// @ts-ignore - CloudFlare Worker type
interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

// CloudFlare Worker export
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // Handle CORS preflight requests
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      }

      // Only handle POST requests to /graphql
      const url = new URL(request.url);
      if (url.pathname !== '/graphql' || request.method !== 'POST') {
        return new Response('Not Found', { status: 404 });
      }

      // Get the request body
      const body = await request.text();

      // Execute the GraphQL request
      const response = await server.executeHTTPGraphQLRequest({
        httpGraphQLRequest: {
          method: request.method,
          headers: request.headers,
          body,
          search: url.search,
        },
        context: async () => ({
          // Add your context here
          // You can access env variables, add authentication, etc.
          env,
          request,
        }),
      });

      // Return the response
      return new Response(response.body, {
        status: response.status || 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          ...Object.fromEntries(response.headers || []),
        },
      });
    } catch (error) {
      console.error('Error processing GraphQL request:', error);
      return new Response(
        JSON.stringify({
          errors: [{ message: 'Internal server error' }],
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  },
};

// Alternative: Using with managed federation (Apollo Studio)
export const managedGatewayExample = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // For managed federation, you would use UplinkSupergraphManager
    // Note: You'll need to create a CloudFlare Worker compatible version
    // of UplinkSupergraphManager as well for this to work
    const gateway = new ApolloGateway({
      // Remove supergraphSdl and let it fetch from Apollo Studio
      buildService({ url }) {
        return new CloudFlareWorkerRemoteGraphQLDataSource({
          url,
          apq: true,
        });
      },
    });

    // Rest of the implementation would be similar...
    return new Response('Managed federation example', { status: 200 });
  },
}; 
