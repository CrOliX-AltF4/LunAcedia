/** Discriminated union of write operations connectors can execute. */
export type ConnectorAction =
    | { kind: "reply"; sourceId: string; body: string }
    | { kind: "complete"; sourceId: string }
    | { kind: "update"; sourceId: string; fields: Record<string, string> };
