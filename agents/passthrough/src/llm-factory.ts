import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AzureChatOpenAI, ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type {
  LlmConfig,
  AzureOpenAIConfig,
  OpenAIConfig,
  AnthropicConfig,
  GoogleConfig,
} from './types.js';

/**
 * Create a LangChain chat model instance based on the resolved LLM configuration.
 */
export function createChatModel(config: LlmConfig): BaseChatModel {
  switch (config.provider) {
    case 'azure-openai': {
      const cfg = config.providerConfig as AzureOpenAIConfig;
      // Extract the instance name from the endpoint URL
      // e.g. https://my-resource.openai.azure.com -> my-resource
      const endpointUrl = new URL(cfg.endpoint);
      const instanceName = endpointUrl.hostname.split('.')[0];

      return new AzureChatOpenAI({
        azureOpenAIApiKey: cfg.apiKey,
        azureOpenAIApiInstanceName: instanceName,
        azureOpenAIApiDeploymentName: cfg.deploymentName,
        azureOpenAIApiVersion: cfg.apiVersion,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
    }

    case 'openai': {
      const cfg = config.providerConfig as OpenAIConfig;
      return new ChatOpenAI({
        openAIApiKey: cfg.apiKey,
        modelName: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
    }

    case 'anthropic': {
      const cfg = config.providerConfig as AnthropicConfig;
      return new ChatAnthropic({
        anthropicApiKey: cfg.apiKey,
        modelName: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
    }

    case 'google': {
      const cfg = config.providerConfig as GoogleConfig;
      return new ChatGoogleGenerativeAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        maxOutputTokens: cfg.maxTokens,
      });
    }

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}
