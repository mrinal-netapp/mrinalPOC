import { ILLMGatewayClient } from './LLMGatewayClient';
import { BifrostGatewayClient } from './BifrostGatewayClient';

export function resolveGatewayBaseUrl(): string {
  return (process.env.LLM_GATEWAY_URL || '').replace(/\/$/, '');
}

export function resolveGatewayApiKey(): string {
  return process.env.LLM_GATEWAY_API_KEY || '';
}

let instance: ILLMGatewayClient | null = null;

export function getLLMGatewayClient(): ILLMGatewayClient {
  if (!instance) {
    instance = new BifrostGatewayClient();
  }
  return instance;
}

export function resetLLMGatewayClientForTests(): void {
  instance = null;
}
