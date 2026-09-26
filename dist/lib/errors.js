// Error types with an attached process exit code.

export class JanitorError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'JanitorError';
    this.exitCode = exitCode;
  }
}

// Bad arguments, refused operations and other problems the user can fix by
// changing the invocation. Exit code 2.
export class UsageError extends JanitorError {
  constructor(message) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

// A request that janitor refuses to send because it could change something
// janitor must never change (visibility, deletion, contents other than LICENSE).
export class SafetyError extends JanitorError {
  constructor(message) {
    super(message, 2);
    this.name = 'SafetyError';
  }
}

export class HttpError extends JanitorError {
  constructor(status, message, { method, url, data } = {}) {
    super(message, 1);
    this.name = 'HttpError';
    this.status = status;
    this.method = method;
    this.url = url;
    this.data = data;
  }
}
