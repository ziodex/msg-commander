const { rm, rmSync } = require('node:fs')

// temp passes literal paths and uses rimraf's old maxBusyTries option.
const removalOptions = (options = {}) => ({
	recursive: true,
	force: true,
	maxRetries: options.maxBusyTries ?? 0,
})

function remove(path, options, callback) {
	if (typeof options === 'function') {
		callback = options
		options = undefined
	}
	rm(path, removalOptions(options), callback)
}

remove.sync = (path, options) => rmSync(path, removalOptions(options))

module.exports = remove
