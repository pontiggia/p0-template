export type StepType = 'command' | 'sql' | 'response';

export interface AgentStep {
  readonly timestamp: string;
  readonly stepType: StepType;
  readonly input: string;
  readonly output: string;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type StepInput = Omit<AgentStep, 'timestamp'>;

export interface AgentSession {
  readonly sessionId: string;
  readonly startTime: string;
  readonly steps: readonly AgentStep[];
  readonly finalQuery?: string | undefined;
  readonly success: boolean;
}

interface MutableSession {
  sessionId: string;
  startTime: string;
  steps: AgentStep[];
  finalQuery?: string | undefined;
  success: boolean;
}

export interface AgentLogEntry extends AgentSession {
  readonly type: 'agent_session';
  readonly totalSteps: number;
  readonly totalDurationMs: number;
}

export interface AgentLogger {
  readonly logStep: (step: StepInput) => void;
  readonly markSuccess: (finalQuery?: string) => void;
  readonly getSession: () => Readonly<AgentSession>;
  readonly flush: () => void;
}

export function createAgentLogger(sessionId: string): AgentLogger {
  const session: MutableSession = {
    sessionId,
    startTime: new Date().toISOString(),
    steps: [],
    success: false,
  };

  return {
    logStep(step: StepInput): void {
      const fullStep: AgentStep = {
        ...step,
        timestamp: new Date().toISOString(),
      };
      session.steps.push(fullStep);
    },

    markSuccess(finalQuery?: string): void {
      session.success = true;
      session.finalQuery = finalQuery;
    },

    getSession(): Readonly<AgentSession> {
      return {
        sessionId: session.sessionId,
        startTime: session.startTime,
        steps: [...session.steps],
        finalQuery: session.finalQuery,
        success: session.success,
      };
    },

    flush(): void {
      const totalDurationMs = session.steps.reduce(
        (sum: number, step: AgentStep) => sum + step.durationMs,
        0,
      );

      const logEntry: AgentLogEntry = {
        type: 'agent_session',
        sessionId: session.sessionId,
        startTime: session.startTime,
        steps: session.steps,
        finalQuery: session.finalQuery,
        success: session.success,
        totalSteps: session.steps.length,
        totalDurationMs,
      };

      console.log(JSON.stringify(logEntry));
    },
  };
}
