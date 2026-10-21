# Features

Msg Commander connects to Azure messaging services through saved connection profiles. Supported service authentication and management permissions differ; data access does not imply permission to create resources or change policies.

## Connections and authentication

Saving a connection profile does not connect to the service. Enter a hostname without a scheme or path. Connection-string profiles use the supplied SAS credentials; Entra device-code sign-in requires a tenant ID and public-client application ID. Event Grid profiles require Entra and a namespace HTTP topics hostname. IoT Hub profiles require an Event Hubs-compatible connection string containing `EntityPath` and ServiceConnect permission.

The **Local emulator** option is specific to Service Bus. Event Hubs Docker checks use a test-only gateway; the other Docker HTTP fixtures are not selectable production endpoints. Setup and required flags are in the [emulator guide](../tests/emulator/README.md).

## Service Bus

Browse queues, topics and subscriptions, including ordinary and transfer dead-letter queues. Peek does not consume messages. Peek-lock receives create held deliveries for explicit complete, abandon, defer or dead-letter actions; receive-and-delete is a separate confirmed operation.

Compose single messages or batches with exact headers and typed properties. Schedule and cancel sends, inspect deferred references, work with session state, and run bounded single-session or concurrent listeners. Test jobs support worker counts, batching, generated payloads and reviewed settlement modes.

Tree actions include resource/policy management, configuration, copying and staged renaming, scoped purges, dead-letter resend and cross-namespace recovery. Read the reviewed source/destination and receipt before repeating any interrupted write. Resending to another namespace is not an atomic move.

## Event Hubs

Use a known hub or browse through a management connection. Inspect partitions and event metadata, preserve original body bytes, send batches and read from explicit positions. Bounded all-partition listeners retain local checkpoints. Checkpoints bind to the namespace, hub, consumer group and hub creation identity; they do not create a distributed processor ownership service.

## IoT Hub

Read device-to-cloud events through the Event Hubs-compatible endpoint, using an existing consumer group. Inspect partitions, listen within bounded limits, save original event bodies and use local checkpoints. IoT Hub connections are read-only: sending, hub/consumer-group administration and IoT device administration are not available. Device connection strings are not supported.

## Event Grid

Connect to a namespace HTTP topics endpoint. Browse and manage supported topics and event subscriptions, publish CloudEvents, and pull/settle events through connection-scoped ownership. Inspect partial settlement results and lost locks before further actions. Classic custom/system topics, domains and MQTT topic spaces are outside this interface.

## Notification Hubs

Manage hubs, tags, policy rights and provider credentials through a management connection. Browse and edit supported registrations, inspect templates and use explicit test notifications. Configuration JSON excludes key material. Registration archives preserve native Azure XML as inert data; this is a current Azure resource representation.

Bulk registration jobs use an explicit storage configuration. Review the selected scope and result; importing configuration does not recreate provider secrets.

## Relay and Hybrid Connections

Manage supported Relay resources and authorization policies; review Msg Commander JSON configuration imports before applying changes. Test known Hybrid Connections with bounded HTTP or stream operations. Resource administration does not imply support for running arbitrary WCF clients or bindings.

## Local files and tools

Save Msg Commander message/event archives, original bodies and local checkpoints. Archive imports create reviewable drafts before sending. Configuration imports stage bounded, expiring plans; unlisted resources and unrelated policy keys are preserved.

Body tools provide strict text encodings and bounded GZip/raw Deflate conversion. JSON/text/hex views do not execute payloads. Saved preferences, themes, tabs, resizable panes and operation logs support local work. Remembered credentials are stored as OS-encrypted ciphertext in the workspace; session-only access remains available.

Installed packages support background update downloads and an explicit restart/install prompt. [Releases and automatic updates](releasing.md) describes when checks run, which packages can update and how active operations and saved connections are handled.

[Architecture](architecture.md) explains the code boundaries. [Testing](testing.md) distinguishes offline, Docker, native and live-service evidence.
