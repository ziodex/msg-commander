import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { backendResults } from '../../src/shared/contracts'

const baseline = JSON.parse(
	readFileSync(resolve('tests/fixtures/protocol-surface.json'), 'utf8'),
) as {
	desktop: Record<string, string>
	backend: string[]
}

function signatureTokens(signature: string) {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		true,
		ts.LanguageVariant.Standard,
		signature,
	)
	const tokens: { kind: ts.SyntaxKind; text: string }[] = []
	let kind: ts.SyntaxKind
	while ((kind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken)
		tokens.push({ kind, text: scanner.getTokenText() })
	// Parameter-list trailing commas and whitespace do not change the public API.
	return tokens
		.filter(
			(token, index) =>
				!(
					token.kind === ts.SyntaxKind.CommaToken &&
					tokens[index + 1]?.kind === ts.SyntaxKind.CloseParenToken
				),
		)
		.map((token) => token.text)
		.join('')
}

it('preserves every public desktop signature across the feature interface split', () => {
	const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile).config
	const options = ts.parseJsonConfigFileContent(config, ts.sys, resolve('.')).options
	const file = resolve('src/shared/contracts/desktop-api.ts')
	const program = ts.createProgram([file], options)
	const source = program.getSourceFile(file)!
	const declaration = source.statements.find(ts.isInterfaceDeclaration)!
	const checker = program.getTypeChecker()
	const members = checker.getPropertiesOfType(checker.getTypeAtLocation(declaration))
	const actual = Object.fromEntries(
		members.map((member) => [member.name, signatureTokens(member.declarations![0].getText())]),
	)
	expect(actual).toEqual(
		Object.fromEntries(
			Object.entries(baseline.desktop).map(([name, signature]) => [
				name,
				signatureTokens(signature),
			]),
		),
	)
})

it('preserves every validated backend method in the canonical result map', () => {
	expect(Object.keys(backendResults).sort()).toEqual(baseline.backend)
})
