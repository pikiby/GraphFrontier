const { CfWorkerJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/cfworker');

// The SDK imports its default provider even when an explicit provider is supplied.
// Keep that constructor functional without bundling AJV's runtime compiler.
class AjvJsonSchemaValidator extends CfWorkerJsonSchemaValidator {
  constructor(ajv) {
    if (ajv !== undefined) throw new Error('Custom AJV instances are not supported in this build');
    super();
  }
}

module.exports = { AjvJsonSchemaValidator };
