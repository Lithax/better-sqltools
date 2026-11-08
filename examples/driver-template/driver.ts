import type { Driver, DriverDescriptor, DriverFactory, SchemaNode } from '../../src/api';

/** A toy driver that "executes" SQL by echoing it back. It exists to show every moving part. */
export const descriptor: DriverDescriptor = {
  id: 'example.echo', // stable and unique; prefix it with your own name
  displayName: 'Echo (example)',
  description: 'Echoes every statement back as a row.',
  icon: 'comment', // any codicon name
  dialect: {
    sqlfluff: 'ansi', // which sqlfluff dialect lints this driver's SQL
    identifierQuote: { open: '"', close: '"' },
    limit: 'limit', // how "select the first N rows" is spelled
  },
  capabilities: { catalog: true },
  // The connection form is generated from this. You ship no UI.
  connectionSchema: [
    { key: 'greeting', label: 'Greeting', type: 'string', default: 'hello' },
    { key: 'token', label: 'API token', type: 'password', required: true }, // kept in secret storage
  ],
};

const tables: SchemaNode[] = [
  { id: 'table:echoes', kind: 'table', label: 'echoes', expandable: true, qualifiedName: '"echoes"' },
];

class EchoDriver implements Driver {
  constructor(
    private readonly greeting: string,
    private readonly token: string,
  ) {}

  async open() {
    if (!this.token) throw new Error('An API token is required.'); // thrown messages are shown to the user
  }

  async close() {}

  // The core splits scripts, so this always receives exactly one statement.
  async execute(sql: string) {
    return { columns: [{ name: 'greeting' }, { name: 'statement' }], rows: [[this.greeting, sql]] };
  }

  // Top level when `parent` is undefined, otherwise the children of that node.
  async children(parent?: SchemaNode): Promise<SchemaNode[]> {
    if (!parent) return tables;
    if (parent.id === 'table:echoes') {
      return ['greeting', 'statement'].map((name) => ({ id: `column:${name}`, kind: 'column' as const, label: name, description: 'TEXT', expandable: false }));
    }
    return [];
  }

  // Optional: one call that feeds completion, instead of the core walking children().
  async catalog() {
    return { tables: [{ name: 'echoes', kind: 'table' as const, columns: [{ name: 'greeting', type: 'TEXT' }, { name: 'statement', type: 'TEXT' }] }] };
  }
}

export class EchoDriverFactory implements DriverFactory {
  readonly descriptor = descriptor;

  create({ options, secrets }: Parameters<DriverFactory['create']>[0]) {
    return new EchoDriver(String(options.greeting), secrets.token ?? '');
  }
}
