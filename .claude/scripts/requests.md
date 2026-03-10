### Request 001
I want you to study the langgraph server API interface and collect all the information needed to build an API implementation to be used as a drop in replacement of the langgraph server.

The actual engine responsible to provide the operations neede to support the API endpoints, initialy must be dummy.

Our primary focus is the accurate replication of the API interface offered by the langgraph server.

### Request 002
It seems that the API is structured in 4 main areas: 
- assistants 
- threads 
- runs & crons
- stores 
I want you to study the documentation available either online or as part of the project, and create a document to explain the purpose and the scope of use for each.
The analysis will drive the design of the actual implementation of the services, and systems supporting and offering the functionality.
I dont want you to create any code, I just want you to study and explain the concepts.

### Request 003 
I want to expose custom agent implementations through the langgraph API interface. 
I want to use the LangGraph API dropin replacement We have create as the interface for a langgraph compatible UI. 
The API will work as an intermediate layer to translate UI action to custom agents. 
I don plan to deploy real LangGraph implemnetations, I just want to use the langGraph API conventions. 
Each agent must be able to get requests from the user and respond to them. 
Each request must composed from the following parts: 
- the conversation history so far
- documents used so far in the conversation 
- the new user request 
- additional documents provided by the user 
I want you to examine this approach and propose any additional feature, capability or component considered useful. 
I want also you to explain which part of the API will be used and propagated to the agent. 
All the content that covers these areas, must be registered in a document. 
I dont want you to create any code, I just want you to study and explain the concepts.


### Request 004
I want you to study investigate and design all the necessary infrastructure required to support custom agents integration to the current implementation, as this integration is described in the ./docs/reference/custom-agent-integration-concepts.md document.
I don't need the actual integration of the custom agent, instead I need all the supporting infrastructure, like the storage and retrieval capabilities. 
For storage purposes I want you to cosider a configurable approach offering at least sqllite, sql server, and Azure blob storage 
- particularly for the blob storage option, I suggest to investigate the option of using the thread id as the file name (propably combined with a time period indicator) used to store and retrieve the user conversation
- to support the multiple storage options, I want you to consider the option of creating a dedicated yaml configuration file (storage-config.yaml) where the various options available will be registered. 
I dont want you to create any code, I just want you to study and explain the concepts.

### Request 005
I want you to proceed with the implementation of the design proposed through the 
./docs/reference/infrastructure-design-storage.md and ./docs/reference/infrastructure-design-storage-part2.md documents 

### Request 006
I want you to create a pass-through agent to be used for test purposes.
The test agent must send every request that gets directly to an llm.
The llm must be configurable through an llm-config,yaml file.
The agent must support various llms from various providers (including azure, google, anthropic).
The agent must use the langchain library to communicate with the llms.
The agent must be implemented as a cli tool and must be totaly isolated from the rest of the current implementation.

A dedicated connector to support the integration between the current implmentation and cli implemented agents must be created to connect the test agent to the current implementation.

Before you try to use the test agent through the lg-api (the current project) you must try the test agent alone to ensure that works correctly.

### Request 007
I want you to enhance the lg-api interface with the agents to exchange a state object additionaly to the current input and output structures 
        Input format (AgentRequest):
        {
          "thread_id": "string",
          "run_id": "string",
          "assistant_id": "string",
          "messages": [{"role": "user|assistant|system", "content": "string"}],
          "documents": [{"id": "string", "title": "string", "content": "string"}],  // optional
          "metadata": {}  // optional
        }

        Output format (AgentResponse):
        {
          "thread_id": "string",
          "run_id": "string",
          "messages": [{"role": "assistant", "content": "string"}],
          "metadata": {}  // optional
        }
The state object must exist in both the input and output messages. 

### Request 008 
I want you to update the swagger to explain for each endpoint how is used, for which purpose. 
make the descriptions as informative as possible 
use content and information from the internet and from the official langgraph site


### Request 009 
I consider the following changes:
1. On startup: Read agent-registry.yaml → for each agent, create a default assistant (if it does not already exist) with graph_id matching the agent key. You must possibly introduce an agent key in the agent-registry.yaml, if one doesn't exist yet.
2. The agent/assistant might be a command-line interface implementation or an API implementation. In the future, we might introduce additional options, like an in-process drop-in agent/assistant.
3. The agent-registry.yaml must bear all the necessary information to make the agent usable e.g. command line instructions, api url, etc.
4. The same instructions might be registered in the assistant's entry into the storage
5. On run execution: Wire the actual pipeline: assistant lookup → graph_id → agent registry → CLI connector → agent execution → SSE streaming
Use the information registered into the docs/reference/investigation-assistant-registration.md to evaluate my proposal, and finalize a proposal to allow the actual integration between the lg-api and the agents.
