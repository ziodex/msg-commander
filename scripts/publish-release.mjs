import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const tag = process.env.GITHUB_REF_NAME
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || process.env.GH_REPO !== 'ziodex/msg-commander')
	throw new Error('A stable version tag and the canonical GitHub repository are required.')
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' })
const releases = JSON.parse(gh(['release', 'list', '--limit', '1000', '--json', 'tagName,isDraft']))
const existing = releases.find((release) => release.tagName === tag)
if (existing && !existing.isDraft)
	throw new Error('Published releases are immutable. Use a new version.')
if (!existing)
	gh([
		'release',
		'create',
		tag,
		'--verify-tag',
		'--draft',
		'--title',
		`Msg Commander ${tag.slice(1)}`,
		'--generate-notes',
	])
const directory = process.argv[2]
const names = await readdir(directory)
if (!['latest.yml', 'latest-mac.yml', 'latest-linux.yml'].every((name) => names.includes(name)))
	throw new Error('All platform update manifests are required before publishing.')
gh(['release', 'upload', tag, ...names.map((name) => join(directory, name)), '--clobber'])
gh(['release', 'edit', tag, '--draft=false', '--latest'])
