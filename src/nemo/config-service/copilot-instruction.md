
# Config service

config-service supports REST API to manage the config andn state for following entities

1. Connector
is a construct that represents. source of data like a filestore, objectstore, database, or stream (kafka, kinesis). The config of this entity includes required fields like name, description, type, connection info (like url/ip address), auth info etc, and also many optional fields depending on the type viz. for file store - the protocol (NFS, SMB).

2.DataSet
represents either collection of files or collection of records.  Datasets are of two types

- unstructured
is a collection of files or objects (from object store). The config of a unsrtuctured dataset will also contain a filter spec, and a list of optional file processors 
- structured
which are collection of records and from database connectors. The config will also contain the SQL query for this dataset

All data sets have name, description, and origin connector list. The dataset may optionally also contain a update trigger spec - which is an expression that can be either a cron or an external event (from pubsub).

Implement the CRUD Apis for the above entities; make sure the API is clean and in REST format. The implementaion of the API stores the info as json content in the mongo db (which is also deployed in the same namespace). Follow a methodical process to first list out the steps and implement. Ask any clarifications.

3.Tool, each tool configuration supports the following properties:
Required (one of the following)

- command (string): Path to the executable for Stdio transport
- url (string): SSE endpoint URL (e.g., "http://localhost:8080/sse")
- httpUrl (string): HTTP streaming endpoint URL

Optional

- args (string[]): Command-line arguments for Stdio transport
- headers (object): Custom HTTP headers when using url or httpUrl
- env (object): Environment variables for the server process. Values can reference environment variables using $VAR_NAME or ${VAR_NAME} syntax
- cwd (string): Working directory for Stdio transport
- timeout (number): Request timeout in milliseconds (default: 600,000ms = 10 minutes)
- trust (boolean): When true, bypasses all tool call confirmations for this tool (default: false)
- includeTools (string[]): List of tool names to include from this tool. When specified, only the tools listed here will be available from this tool (allowlist behavior). If not specified, all tools are enabled by default.
- excludeTools (string[]): List of tool names to exclude from this tool. Tools listed here will not be available to the model, even if they are exposed by the tool. Note: excludeTools takes precedence over includeTools - if a tool is in both lists, it will be excluded.  

implement the CRUD Apis, as well as swagger, history and revert-version apis.

4.Model, each model config supports the following properties:
Required
- name : string
- model_info: 
  - architecture : string
  - base_model : string
  - variant : string
  - parameters : string
  - quantization: string
  - size: number
- endpoint : URL
- auth:
  - access_token : string
  - secret_key : string
- limits
  - tpm : number
  - timeout : number
  - stream_timeout : number
  - max_retries : number
implement the CRUD Apis, as well as swagger, history and revert-version apis.


