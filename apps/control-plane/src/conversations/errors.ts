export class AgentToolRefusal extends Error {}

export class ArchivedChannelError extends Error {
  constructor() {
    super("Archived channels are read-only");
    this.name = "ArchivedChannelError";
  }
}
