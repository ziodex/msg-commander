import { desktopChannelMethods } from '../../src/shared/contracts/desktop-channels'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import ts from 'typescript'
import baseline from '../fixtures/contracts/desktop-api.json'
import { createWorkspaceBridge } from '../../src/preload/features/workspace'
import { createServiceBusBridge } from '../../src/preload/features/service-bus'
import { createTestJobBridge } from '../../src/preload/features/service-bus/test-jobs'
import { createEventHubsBridge } from '../../src/preload/features/event-hubs'
import { createEventGridBridge } from '../../src/preload/features/event-grid'
import { createNotificationHubsBridge } from '../../src/preload/features/notification-hubs'
import { createRelayBridge } from '../../src/preload/features/relay'
import { createBodyToolsBridge } from '../../src/preload/features/body-tools'
import { createResourceConfigurationBridge } from '../../src/preload/features/resource-configuration'

function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
	)
}

it('preserves every public desktop method, channel, argument and response through the feature bridges', async () => {
	expect(desktopChannelMethods).toEqual(
		Object.fromEntries(
			Object.entries(baseline.methods).map(([method, spec]) => [spec.channel, method]),
		),
	)
	const response = { ok: true, value: { retained: true } }
	const invoke = vi.fn().mockResolvedValue(response)
	const bridge = {
		...createWorkspaceBridge(invoke),
		...createServiceBusBridge(invoke),
		...createTestJobBridge(invoke),
		...createEventHubsBridge(invoke),
		...createEventGridBridge(invoke),
		...createNotificationHubsBridge(invoke),
		...createRelayBridge(invoke),
		...createBodyToolsBridge(invoke),
		...createResourceConfigurationBridge(invoke),
	}
	expect(Object.keys(bridge).sort()).toEqual(Object.keys(baseline.methods).sort())
	for (const [name, method] of Object.entries(bridge)) {
		const expected = baseline.methods[name as keyof typeof baseline.methods]
		const argument = { contractCheck: name }
		const args = Array.from({ length: expected.parameters }, () => argument)
		invoke.mockClear()
		expect(await Reflect.apply(method, undefined, args), name).toBe(response)
		expect(invoke, name).toHaveBeenCalledExactlyOnceWith(expected.channel, ...args)
	}
})

it('registers exactly the public request channels through the shared validated registrar', () => {
	const channels: string[] = []
	for (const path of files(resolve('src/main/features')).filter((path) =>
		path.endsWith('register-ipc.ts'),
	)) {
		const source = ts.createSourceFile(
			path,
			readFileSync(path, 'utf8'),
			ts.ScriptTarget.Latest,
			true,
		)
		function visit(node: ts.Node) {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'handle'
			) {
				expect(ts.isStringLiteral(node.arguments[0]), path).toBe(true)
				channels.push((node.arguments[0] as ts.StringLiteral).text)
			}
			ts.forEachChild(node, visit)
		}
		visit(source)
	}
	expect(new Set(channels).size).toBe(channels.length)
	expect(channels.sort()).toEqual(
		Object.values(baseline.methods)
			.map((method) => method.channel)
			.sort(),
	)
	const bypasses = files(resolve('src/main')).filter(
		(path) => path.endsWith('.ts') && readFileSync(path, 'utf8').includes('ipcMain.handle('),
	)
	expect(bypasses).toEqual([resolve('src/main/ipc/registrar.ts')])
})
