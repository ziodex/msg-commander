import { EventGridController } from '../features/event-grid/controller'
import { BodyCodecFiles } from '../features/body-tools/files'

import { NotificationHubRegistrationFiles } from '../features/notification-hubs/registrations/files'

import { NotificationHubFiles } from '../features/notification-hubs/configuration/files'

import { NotificationHubCredentialFiles } from '../features/notification-hubs/credentials/files'
import { NotificationSenderController } from '../features/notification-hubs/notifications/controller'

import { NotificationHubRegistrationsController } from '../features/notification-hubs/registrations/controller'

import { NotificationHubsController } from '../features/notification-hubs/controller'

import { RelayFiles } from '../features/relay/files'

import { HybridController } from '../features/relay/hybrid-controller'

import { RelayController } from '../features/relay/controller'

import { EventFiles } from '../features/event-hubs/files'
import { MessagingConfigurationFiles } from '../features/resource-configuration/files'
import { type MessagingService } from '../../shared/contracts/resource-configuration'

import { EventHubsController } from '../features/event-hubs/controller'

import { clipboard, BrowserWindow, dialog } from 'electron'
import { Backend, HostError } from '../platform/backend'
import { MessageFiles } from '../features/service-bus/files/message-files'

import { WorkspaceStore } from '../platform/workspace-store'
import { ServiceBusController } from '../features/service-bus/controller'

import { type AppEvent } from '../../shared/contracts'

export function createApplicationServices(
	backend: Backend,
	workspace: WorkspaceStore,
	getWindow: () => BrowserWindow | undefined,
	broadcast: (event: AppEvent) => void,
) {
	let messageFiles: MessageFiles | undefined
	const bodyCodecs = new BodyCodecFiles(
		{ request: (...args) => backend.request(...args) },
		{
			open: async () => {
				const value = await dialog.showOpenDialog(getWindow()!, {
					title: 'Open body bytes',
					properties: ['openFile', 'dontAddToRecent'],
				})
				return value.canceled ? undefined : value.filePaths[0]
			},
			save: async () => {
				const value = await dialog.showSaveDialog(getWindow()!, {
					title: 'Save converted body',
					defaultPath: 'ConvertedBody.bin',
					properties: ['dontAddToRecent'],
				})
				return value.canceled ? undefined : value.filePath
			},
		},
	)
	const serviceBus = new ServiceBusController(backend, () => {
		messageFiles?.clear()
		broadcast({ type: 'namespace-reset' })
	})
	const hybrid = new HybridController(backend, () => broadcast({ type: 'hybrid-reset' }))
	const nh = new NotificationHubsController(backend, () => {
		registrations?.forget()
		notifications?.forget()
		broadcast({ type: 'notification-hubs-reset' })
	})
	const registrations = new NotificationHubRegistrationsController(
		backend,
		(id) => nh.require(id),
		(id) => workspace.getForBackend(id),
		() => broadcast({ type: 'notification-hub-registrations-reset' }),
	)
	const notifications = new NotificationSenderController(
		backend,
		(id) => nh.require(id),
		(id) => workspace.getForBackend(id),
		() => broadcast({ type: 'notification-sender-reset' }),
	)
	const grid = new EventGridController(backend, () => broadcast({ type: 'event-grid-reset' }))
	const relay = new RelayController(backend, () => broadcast({ type: 'relay-reset' }))
	const credentialFiles = new NotificationHubCredentialFiles(
		backend,
		(id) => nh.require(id),
		async (provider) => {
			const result = await dialog.showOpenDialog(getWindow()!, {
				title: 'Import private provider credential',
				properties: ['openFile', 'dontAddToRecent'],
				filters: [
					{
						name: 'Provider credential',
						extensions:
							provider === 'apns-token'
								? ['p8']
								: provider === 'fcm-v1'
									? ['json']
									: ['p12', 'pfx', 'pem'],
					},
				],
			})
			return result.canceled ? undefined : result.filePaths[0]
		},
	)
	const registrationFiles = new NotificationHubRegistrationFiles(
		backend,
		(id) => registrations.require(id),
		{
			open: async () => {
				const result = await dialog.showOpenDialog(getWindow()!, {
					title: 'Import registrations',
					properties: ['openFile', 'dontAddToRecent'],
					filters: [
						{ name: 'Notification Hubs registrations', extensions: ['json', 'xml'] },
					],
				})
				return result.canceled ? undefined : result.filePaths[0]
			},
			save: async (format) => {
				const result = await dialog.showSaveDialog(getWindow()!, {
					title: 'Export registrations',
					defaultPath:
						format === 'json' ? 'registrations.msgc.json' : 'registrations.xml',
					properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
					filters: [
						{
							name:
								format === 'json'
									? 'Commander registration archive'
									: 'Azure Atom registrations',
							extensions: [format],
						},
					],
				})
				return result.canceled ? undefined : result.filePath
			},
		},
	)
	const nhFiles = new NotificationHubFiles(backend, (id) => nh.require(id), {
		open: async () => {
			const result = await dialog.showOpenDialog(getWindow()!, {
				title: 'Import Notification Hubs configuration',
				properties: ['openFile', 'dontAddToRecent'],
				filters: [{ name: 'Commander configuration JSON', extensions: ['json'] }],
			})
			return result.canceled ? undefined : result.filePaths[0]
		},
		save: async (format) => {
			const result = await dialog.showSaveDialog(getWindow()!, {
				title: 'Export Notification Hubs configuration',
				defaultPath: 'notification-hubs.msgc.json',
				properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
				filters: [
					{
						name: 'Commander Notification Hubs configuration',
						extensions: [format],
					},
				],
			})
			return result.canceled ? undefined : result.filePath
		},
	})
	const relayFiles = new RelayFiles(backend, (id) => relay.require(id), {
		open: async () => {
			const result = await dialog.showOpenDialog(getWindow()!, {
				title: 'Import Relay configuration',
				properties: ['openFile', 'dontAddToRecent'],
				filters: [{ name: 'Commander configuration JSON', extensions: ['json'] }],
			})
			return result.canceled ? undefined : result.filePaths[0]
		},
		save: async (format) => {
			const result = await dialog.showSaveDialog(getWindow()!, {
				title: 'Export Relay configuration',
				defaultPath: 'relay.msgc.json',
				properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
				filters: [
					{
						name: 'Commander Relay configuration',
						extensions: [format],
					},
				],
			})
			return result.canceled ? undefined : result.filePath
		},
	})
	const eventHubs = new EventHubsController(backend, () => {
		eventFiles?.clear()
		broadcast({ type: 'event-hubs-reset' })
	})
	const messagingFiles = new MessagingConfigurationFiles(backend, requireMessaging, {
		open: async (service) => {
			const result = await dialog.showOpenDialog(getWindow()!, {
				title: `Import ${service === 'service-bus' ? 'Service Bus' : 'Event Hubs'} configuration`,
				properties: ['openFile', 'dontAddToRecent'],
				filters: [{ name: 'Commander configuration JSON', extensions: ['json'] }],
			})
			return result.canceled ? undefined : result.filePaths[0]
		},
		save: async (service, format) => {
			const result = await dialog.showSaveDialog(getWindow()!, {
				title: 'Export messaging configuration',
				defaultPath: `${service}-configuration.${format}`,
				filters: [
					{
						name: 'Commander JSON (without keys)',
						extensions: [format],
					},
				],
				properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
			})
			return result.canceled ? undefined : result.filePath
		},
	})
	const eventFiles = new EventFiles(backend, (id) => eventHubs.require(id), {
		open: async (format) => {
			const result = await dialog.showOpenDialog(getWindow()!, {
				title:
					format === 'checkpoint'
						? 'Load Event Hubs checkpoint'
						: 'Import Event Hubs events',
				properties:
					format === 'checkpoint'
						? ['openFile', 'dontAddToRecent']
						: ['openFile', 'multiSelections', 'dontAddToRecent'],
				filters:
					format === 'body'
						? [{ name: 'Event body files', extensions: ['*'] }]
						: [
								{
									name:
										format === 'checkpoint'
											? 'Commander Event Hubs checkpoint'
											: 'Commander Event Hubs archive',
									extensions: ['json'],
								},
							],
			})
			return result.canceled ? [] : result.filePaths
		},
		save: async (format) => {
			const result = await dialog.showSaveDialog(getWindow()!, {
				title:
					format === 'checkpoint'
						? 'Save Event Hubs checkpoint'
						: 'Export Event Hubs events',
				defaultPath:
					format === 'checkpoint'
						? 'event-checkpoint.msgc.json'
						: format === 'archive'
							? 'events.msgc.json'
							: 'event-body.bin',
				properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
				filters: [
					{
						name: format === 'body' ? 'Event body' : 'Commander Event Hubs file',
						extensions: format === 'body' ? ['bin', 'json', 'txt'] : ['json'],
					},
				],
			})
			return result.canceled ? undefined : result.filePath
		},
	})
	messageFiles = new MessageFiles(backend, (id) => serviceBus.require(id), {
		copy: (text) => clipboard.writeText(text),
		open: async (format) => {
			const result = await dialog.showOpenDialog(getWindow()!, {
				title:
					format === 'archive'
						? 'Import Commander message archives'
						: 'Import message body files',
				properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
				filters:
					format === 'archive'
						? [{ name: 'Commander message archive', extensions: ['json'] }]
						: [
								{ name: 'Message bodies', extensions: ['json', 'txt', 'bin'] },
								{ name: 'All files', extensions: ['*'] },
							],
			})
			return result.canceled ? [] : result.filePaths
		},
		save: async (format) => {
			const result = await dialog.showSaveDialog(getWindow()!, {
				title:
					format === 'archive'
						? 'Save Commander message archive'
						: 'Save complete message body',
				defaultPath: format === 'archive' ? 'messages.msgc.json' : 'message-body.bin',
				properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
				filters:
					format === 'archive'
						? [{ name: 'Commander message archive', extensions: ['json'] }]
						: [
								{ name: 'Body bytes', extensions: ['bin', 'json', 'txt'] },
								{ name: 'All files', extensions: ['*'] },
							],
			})
			return result.canceled ? undefined : result.filePath
		},
	})

	function requireMessaging(service: MessagingService, connectionId: string) {
		if (service === 'service-bus') serviceBus.require(connectionId)
		else if (eventHubs.require(connectionId).service === 'iot-hub')
			throw new HostError(
				'INVALID_REQUEST',
				'Use an Event Hubs management connection for resource configuration.',
			)
	}
	const resetNamespaces = async () => {
		await Promise.all([
			serviceBus.reset(),
			eventHubs.reset(),
			nh.reset(),
			registrations.reset(),
			notifications.reset(),
			relay.reset(),
			grid.reset(),
			hybrid.reset(),
		])
	}
	function forgetConnections() {
		for (const controller of [serviceBus, eventHubs, nh, relay, grid, hybrid])
			controller.forget()
	}
	return {
		bodyCodecs,
		serviceBus,
		eventHubs,
		hybrid,
		registrationFiles,
		nhFiles,
		relayFiles,
		notifications,
		registrations,
		credentialFiles,
		nh,
		grid,
		relay,
		eventFiles,
		messagingFiles,
		messageFiles,
		requireMessaging,
		resetNamespaces,
		forgetConnections,
	}
}
export type ApplicationServices = ReturnType<typeof createApplicationServices>
