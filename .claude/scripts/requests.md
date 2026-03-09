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


### Request 003 
I want you to connect a configuration based service for the assistants. 

An assistant-config.yaml will be used to allow the expose of assistants either through a REST API, or a command line interface to the 

For each assistant I want a 