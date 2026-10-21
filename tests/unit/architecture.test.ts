import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { expect, it } from 'vitest'

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (['bin', 'obj'].includes(entry.name)) return []
		const path = join(directory, entry.name)
		return entry.isDirectory() ? sources(path) : /\.(cs|ts|vue)$/.test(path) ? [path] : []
	})
}

const references = {
	Domain: [],
	Contracts: [],
	Application: ['Contracts', 'Domain'],
	Infrastructure: ['Application'],
	Host: ['Application', 'Infrastructure'],
}

it('keeps Host free of provider dependencies and all remaining feature state in Application', () => {
	const directory = resolve('backend/MsgCommander.Host')
	expect(readFileSync(join(directory, 'MsgCommander.Host.csproj'), 'utf8')).not.toContain(
		'<PackageReference',
	)
	for (const file of sources(directory))
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/using (?:Azure\.|Microsoft\.Azure\.)|\b(?:ServiceBusException|RequestFailedException|TokenCredential|ArmClient)\b/,
		)
	for (const name of [
		'NotificationHubRegistrationsWorkspace',
		'NotificationHubNotificationsWorkspace',
		'RelayWorkspace',
		'HybridWorkspace',
	])
		expect(readFileSync(join(directory, name + '.cs'), 'utf8'), name).not.toMatch(
			/\b(?:SemaphoreSlim|Dictionary|Stopwatch|configPreview|jobReview)\b/,
		)
	for (const file of sources(resolve('backend/MsgCommander.Application/Relay')))
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/\b(?:HttpClient|RequestFailedException|JsonObject)\b|JsonElement input/,
		)
	for (const file of sources(resolve('backend/MsgCommander.Contracts/Relay')))
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/\b(?:Validate|OperationException|Suffix|GatewayFactory)\b/,
		)
})

it('keeps production modules below the review skill’s 1000-line decomposition limit', () => {
	for (const directory of ['src', 'backend']) {
		for (const file of sources(resolve(directory)))
			expect(readFileSync(file, 'utf8').split('\n').length, file).toBeLessThan(1000)
	}
})

it('keeps the shared contract entry point free of feature definitions', () => {
	const code = readFileSync(resolve('src/shared/contracts.ts'), 'utf8')
	expect(code).not.toMatch(/export\s+(?:const|interface|type|class)\s/)
	expect(code.split('\n').length).toBeLessThan(50)
})

it('keeps Notification Hubs management workflows and private provider mapping in their owning layers', () => {
	for (const file of sources(resolve('backend/MsgCommander.Application/NotificationHubs'))) {
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/\b(JsonObject|JsonNode|HttpClient|ArmClient|X509Certificate2|Pkcs12Builder)\b|JsonElement\s+input|GetProperty\("(?:apnsCredential|fcmV1Credential|wnsCredential)"\)/,
		)
	}
	const facade = readFileSync(
		resolve('backend/MsgCommander.Host/NotificationHubWorkspace.cs'),
		'utf8',
	)
	expect(facade).not.toMatch(
		/\b(SemaphoreSlim|Dictionary|configPreview|credentialArtifacts|NotificationHubReceiptStore)\b/,
	)
	for (const file of sources(resolve('backend/MsgCommander.Contracts/NotificationHubs')))
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/\b(?:void\s+Validate|JsonObject|ProviderCredentialMaterial)\b/,
		)
	const host = readFileSync(resolve('backend/MsgCommander.Host/MsgCommander.Host.csproj'), 'utf8')
	expect(host).not.toContain('PackageReference Include="System.Security.Cryptography.Pkcs"')
})

for (const [layer, allowed] of Object.entries(references)) {
	it(`enforces the ${layer} project dependency boundary`, () => {
		const directory = resolve(`backend/MsgCommander.${layer}`)
		const project = readFileSync(join(directory, `MsgCommander.${layer}.csproj`), 'utf8')
		const actual = [
			...project.matchAll(
				/<ProjectReference Include="[^"]*MsgCommander\.([^.\/]+)\.csproj"/g,
			),
		]
			.map((match) => match[1])
			.sort()
		expect(actual).toEqual([...allowed].sort())
		if (['Domain', 'Contracts', 'Application'].includes(layer)) {
			expect(project).not.toContain('<PackageReference')
			for (const path of sources(directory)) {
				const code = readFileSync(path, 'utf8')
				expect(code, path).not.toMatch(/\bAzure\.[A-Za-z_]/)
				expect(code, path).not.toMatch(/MsgCommander\.(Host|Infrastructure)\b/)
				if (layer === 'Domain')
					expect(code, path).not.toMatch(/MsgCommander\.(Application|Contracts)\b/)
				if (layer === 'Contracts')
					expect(code, path).not.toMatch(/MsgCommander\.(Application|Domain)\b/)
			}
		}
	})
}

it('keeps the test-job desktop bridge behind the feature API', () => {
	const directory = resolve('src/renderer/src/features/service-bus/test-jobs')
	for (const path of sources(directory).filter((path) => !path.endsWith('api.ts'))) {
		expect(readFileSync(path, 'utf8'), path).not.toContain('window.commander')
	}
})

it('keeps Service Bus messaging and listener workflows free of transport parsing and SDK bridges', () => {
	for (const path of sources(resolve('backend/MsgCommander.Application/ServiceBus'))) {
		const code = readFileSync(path, 'utf8')
		expect(code, path).not.toMatch(
			/\b(ProtocolException|ITestJobSdkReceiver|SdkTestJobReceiver)\b/,
		)
		expect(code, path).not.toMatch(/\bnew\s+OperationException\(\s*-\d/)
		if (
			[
				`${sep}Listeners${sep}`,
				`${sep}Administration${sep}`,
				`${sep}Messages${sep}`,
				`${sep}Sessions${sep}`,
				`${sep}Maintenance${sep}`,
				`${sep}Workspace${sep}`,
			].some((part) => path.includes(part))
		)
			expect(code, path).not.toContain('JsonElement')
	}
})

it('keeps Infrastructure independent of Host and the Service Bus SDK implementation out of Host', () => {
	for (const path of sources(resolve('backend/MsgCommander.Infrastructure')))
		expect(readFileSync(path, 'utf8'), path).not.toMatch(/MsgCommander\.Host\b/)
	for (const path of sources(resolve('backend/MsgCommander.Host')))
		expect(readFileSync(path, 'utf8'), path).not.toMatch(
			/\b(?:partial\s+class\s+AzureServiceBusGateway|new\s+ServiceBusAdministrationClient)\b/,
		)
})

it('keeps Event Hubs SDKs and workflow state behind Application ports', () => {
	for (const path of sources(resolve('backend/MsgCommander.Application/EventHubs'))) {
		if (path.includes(`${sep}Configuration${sep}`)) continue
		expect(readFileSync(path, 'utf8'), path).not.toMatch(
			/\b(JsonElement|EventData|EventPosition|PartitionReceiver|EventHubProducerClient)\b/,
		)
	}
	for (const file of [
		resolve('backend/MsgCommander.Host/EventHubsWorkspace.cs'),
		...sources(resolve('backend/MsgCommander.Host/Features/EventHubs')),
	])
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/\b(Stopwatch|SemaphoreSlim|Dictionary|EventHubsException|PartitionReceiver)\b/,
		)
	const project = readFileSync(
		resolve('backend/MsgCommander.Host/MsgCommander.Host.csproj'),
		'utf8',
	)
	expect(project).not.toMatch(
		/PackageReference Include="Azure\.(Messaging|ResourceManager)\.EventHubs"/,
	)
})

it('keeps Event Grid transport parsing and ARM definitions out of Application workflows', () => {
	for (const file of sources(resolve('backend/MsgCommander.Application/EventGrid'))) {
		const code = readFileSync(file, 'utf8')
		expect(code, file).not.toMatch(
			/\b(HttpClient|JsonObject|RequestFailedException)\b|\.Deserialize<EventGrid|JsonElement input|GetProperty\("(?:brokerProperties|lockToken|succeededLockTokens|failedLockTokens)"\)/,
		)
	}
	for (const file of [
		resolve('backend/MsgCommander.Host/EventGridWorkspace.cs'),
		...sources(resolve('backend/MsgCommander.Host/Features/EventGrid')),
	])
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/\b(SemaphoreSlim|Dictionary|Stopwatch|EventGridLockToken)\b/,
		)
	for (const file of sources(resolve('backend/MsgCommander.Contracts/EventGrid')))
		expect(readFileSync(file, 'utf8'), file).not.toMatch(
			/\b(?:Validate|Definition|Suffix)\s*\(/,
		)
})

it('keeps Service Bus workflow state and broker failure handling out of Host endpoints', () => {
	const files = [
		resolve('backend/MsgCommander.Host/ServiceBusWorkspace.cs'),
		...sources(resolve('backend/MsgCommander.Host/Features/ServiceBus')),
	]
	for (const file of files) {
		const code = readFileSync(file, 'utf8')
		expect(code, file).not.toMatch(
			/\b(ServiceBusException|ServiceBusFailureReason|Stopwatch)\b/,
		)
		expect(code, file).not.toMatch(/\bDictionary\s*</)
		expect(code, file).not.toMatch(/\b(ConnectionScope|ReceiverOwner|ListenerCoordinator)\b/)
		expect(code, file).not.toMatch(/\bauthorizationOperationId\b/)
		if (file.includes(`${sep}Features${sep}`))
			expect(code, file).not.toContain('MsgCommander.Infrastructure')
	}
})

it('keeps every renderer feature behind a typed desktop API', () => {
	for (const path of sources(resolve('src/renderer/src/features'))) {
		if (path.endsWith('api.ts')) continue
		expect(readFileSync(path, 'utf8'), path).not.toContain('window.commander')
	}
})

it('keeps shared renderer code independent of feature and application modules', () => {
	const renderer = resolve('src/renderer/src')
	for (const path of sources(resolve('src/renderer/src/shared'))) {
		for (const dependency of rendererDependencies(path))
			expect(relative(renderer, dependency).split(sep)[0], path).not.toMatch(
				/^(features|app)$/,
			)
	}
})

function rendererDependencies(path: string): string[] {
	return [...readFileSync(path, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].flatMap(
		([, specifier]) => {
			if (specifier.startsWith('@/')) return [resolve('src/renderer/src', specifier.slice(2))]
			if (specifier.startsWith('.')) return [resolve(dirname(path), specifier)]
			return []
		},
	)
}

it('uses public entry points between renderer features and keeps their dependencies acyclic', () => {
	const features = resolve('src/renderer/src/features'),
		renderer = resolve('src/renderer/src')
	const graph = new Map<string, Set<string>>()
	for (const path of sources(renderer)) {
		const owner = path.startsWith(features + sep)
			? relative(features, path).split(sep)[0]
			: undefined
		for (const dependency of rendererDependencies(path)) {
			if (!dependency.startsWith(features + sep)) continue
			const [feature, ...internal] = relative(features, dependency).split(sep)
			if (feature === owner) continue
			expect(internal, `${path} imports ${dependency}`).toEqual([])
			if (owner) {
				if (!graph.has(owner)) graph.set(owner, new Set())
				graph.get(owner)!.add(feature)
			}
		}
	}
	const visit = (feature: string, ancestors: string[]) => {
		expect(ancestors, `Feature cycle: ${[...ancestors, feature].join(' → ')}`).not.toContain(
			feature,
		)
		for (const dependency of graph.get(feature) ?? [])
			visit(dependency, [...ancestors, feature])
	}
	for (const feature of graph.keys()) visit(feature, [])
})

it('keeps resource configuration independent of its consuming messaging features', () => {
	for (const path of sources(resolve('src/renderer/src/features/resource-configuration'))) {
		const imports = [...readFileSync(path, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)]
		for (const [, specifier] of imports)
			expect(specifier, path).not.toMatch(/(?:^|\/)(service-bus|event-hubs)(?:\/|$)/)
	}
})

it('keeps configuration commands typed and its SDK validation outside Application', () => {
	for (const directory of [
		'backend/MsgCommander.Application/ResourceConfiguration',
		'backend/MsgCommander.Application/ServiceBus/Configuration',
		'backend/MsgCommander.Application/EventHubs/Configuration',
	]) {
		for (const path of sources(resolve(directory))) {
			const code = readFileSync(path, 'utf8')
			expect(code, path).not.toMatch(/JsonElement\s+input\b/)
			expect(code, path).not.toMatch(/MsgCommander\.Host\b|\bAzure\.[A-Za-z_]/)
			expect(code, path).not.toMatch(/\bnew\s+EventHubData\b|AzureEventHubsAdministration/)
		}
	}
})
