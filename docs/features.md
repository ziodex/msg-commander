# Features

Msg Commander connects to Azure messaging services through saved connection profiles. Supported service authentication and management permissions differ; data access does not imply permission to create resources or change policies.

## Service Bus

Browse queues, topics and subscriptions, including ordinary and transfer dead-letter queues. Peek does not consume messages. Peek-lock receives create held deliveries for explicit complete, abandon, defer or dead-letter actions; receive-and-delete is a separate confirmed operation.

Compose single messages or batches with exact headers and typed properties. Schedule and cancel sends, inspect deferred references, work with session state, and run bounded single-session or concurrent listeners. Test jobs support worker counts, batching, generated payloads and reviewed settlement modes.

Tree actions include resource/policy management, configuration, copying and staged renaming, scoped purges, dead-letter resend and cross-namespace recovery. Read the reviewed source/destination and receipt before repeating any interrupted write. Resending to another namespace is not an atomic move.

## Event Hubs and IoT Hub

Use a known hub or browse through a management connection. Inspect partitions and event metadata, preserve original body bytes, send batches and read from explicit positions. Bounded all-partition listeners retain local checkpoints. Checkpoints bind to the namespace, hub, consumer group and hub creation identity; they do not create a distributed processor ownership service.

IoT Hub access covers its Event Hubs-compatible endpoint. It does not provide IoT device administration.

## Event Grid

Connect to a namespace HTTP topics endpoint. Browse and manage supported topics and event subscriptions, publish CloudEvents, and pull/settle events through connection-scoped ownership. Inspect partial settlement results and lost locks before further actions. Classic custom/system topics, domains and MQTT topic spaces are outside this interface.

## Notification Hubs

Manage hubs, tags, policy rights and provider credentials through a management connection. Browse and edit supported registrations, inspect templates and use explicit test notifications. Configuration JSON excludes key material. Registration archives preserve native Azure XML as inert data; this is a current Azure resource representation.

Bulk registration jobs use an explicit storage configuration. Review the selected scope and result; importing configuration does not recreate provider secrets.

## Relay and Hybrid Connections

Manage supported Relay resources and authorization policies; review Msg Commander JSON configuration imports before applying changes. Test known Hybrid Connections with bounded HTTP or stream operations. Resource administration does not imply support for running arbitrary WCF clients or bindings.

## Local files and tools

Save Msg Commander message/event archives, original bodies and local checkpoints. Archive imports create reviewable drafts before sending. Configuration imports stage bounded, expiring plans; unlisted resources and unrelated policy keys are preserved.

Body tools provide strict text encodings and bounded GZip/raw Deflate conversion. JSON/text/hex views do not execute payloads. Saved preferences, themes, tabs, resizable panes and operation logs support local work. Remembered credentials use the OS credential store when available; session-only access remains available.

[Architecture](architecture.md) explains the code boundaries. [Testing](testing.md) distinguishes offline, Docker, native and live-service evidence.
