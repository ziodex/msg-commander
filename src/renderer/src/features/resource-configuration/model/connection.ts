// The connection and operation state supplied by the owning messaging feature.
export interface ConfigurationConnection {
	readonly connection:
		{ connectionId: string; namespace: string; managementAvailable?: boolean } | undefined
	busy: string
	error: string
}
