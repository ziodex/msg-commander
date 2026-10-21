import { basename } from 'node:path'
import { writeFile } from 'node:fs/promises'
import {
	formatOperationLog,
	operationLogSchema,
	type OperationLogRequest,
} from '../../../shared/desktop-tools'
type Ports = {
	copy: (text: string) => void
	save: () => Promise<string | undefined>
}
export async function exportOperationLog(input: OperationLogRequest, ports: Ports) {
	const parsed = operationLogSchema.parse(input)
	const text = formatOperationLog(parsed)
	if (parsed.destination === 'clipboard') {
		ports.copy(text)
		return { cancelled: false }
	}
	const path = await ports.save()
	if (!path) return { cancelled: true }
	await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
	return { cancelled: false, fileName: basename(path) }
}
