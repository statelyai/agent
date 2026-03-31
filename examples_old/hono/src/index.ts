import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { emailMachine } from './machine';
import { db } from './db';
import { getAgentDecision, requiresAgentDecision } from './agent';
import { transition } from 'xstate';

type Bindings = {
  OPENAI_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// GET / - Simple UI
app.get('/', async (c) => {
  const sessionId = c.req.query('sessionId');
  let initialSession = null;

  if (sessionId) {
    const session = db.getSession(sessionId);
    if (session) {
      initialSession = {
        sessionId,
        state: { value: session.value, context: session.context },
      };
    }
  }

  return c.html(html`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Email Agent</title>
        <style>
          body {
            font-family: system-ui;
            max-width: 800px;
            margin: 2rem auto;
            padding: 0 1rem;
          }
          pre {
            background: #f5f5f5;
            padding: 1rem;
            overflow: auto;
          }
          button {
            margin: 0.25rem;
            padding: 0.5rem 1rem;
            cursor: pointer;
          }
          .state {
            font-size: 1.5rem;
            font-weight: bold;
            color: #333;
          }
          .agent-response {
            background: #e8f4e8;
            padding: 1rem;
            margin: 1rem 0;
            border-radius: 4px;
          }
          #events {
            margin: 1rem 0;
          }
          #start-form {
            margin-bottom: 2rem;
          }
          input[type='text'] {
            padding: 0.5rem;
            width: 300px;
          }
        </style>
      </head>
      <body>
        <h1>Email Agent</h1>

        <div id="start-form">
          <input
            type="text"
            id="userRequest"
            placeholder="e.g., Email John about the meeting tomorrow"
          />
          <button onclick="startSession()">Start Session</button>
        </div>

        <div id="session-info" style="display:none">
          <p><strong>Session:</strong> <span id="sessionId"></span></p>
          <p class="state">State: <span id="stateValue"></span></p>

          <div id="agent-response" class="agent-response" style="display:none">
            <strong>Agent Response:</strong>
            <pre id="agentResponseContent"></pre>
          </div>

          <h3>Context</h3>
          <pre id="context"></pre>

          <div id="events">
            <h3>Actions</h3>
            <button onclick="sendEvent('provideClarification')">
              Provide Clarification
            </button>
            <button onclick="sendEvent('confirm')">Confirm Email</button>
          </div>

          <h3>History</h3>
          <button onclick="loadHistory()">Load History</button>
          <pre id="history"></pre>
        </div>

        <script>
          let currentSessionId = null;
          const initialSession = ${raw(JSON.stringify(initialSession))};

          if (initialSession) {
            currentSessionId = initialSession.sessionId;
            document.addEventListener('DOMContentLoaded', () => {
              updateUI(initialSession);
              document.getElementById('session-info').style.display = 'block';
            });
          }

          async function startSession() {
            const userRequest = document.getElementById('userRequest').value;
            if (!userRequest) return alert('Enter a request');

            const res = await fetch('/sessions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userRequest }),
            });
            const data = await res.json();
            currentSessionId = data.sessionId;
            history.pushState(
              { sessionId: data.sessionId },
              '',
              '?sessionId=' + data.sessionId
            );
            updateUI(data);
            document.getElementById('session-info').style.display = 'block';
          }

          async function sendEvent(type) {
            if (!currentSessionId) return;

            let payload = { type };

            if (type === 'provideClarification') {
              const answers = prompt('Enter your answers/clarification:');
              if (!answers) return;
              payload.answers = answers;
            }

            const res = await fetch(
              '/sessions/' + currentSessionId + '/events',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              }
            );
            const data = await res.json();
            updateUI({ sessionId: currentSessionId, ...data });
          }

          async function loadHistory() {
            if (!currentSessionId) return;
            const res = await fetch(
              '/sessions/' + currentSessionId + '/history'
            );
            const data = await res.json();
            document.getElementById('history').textContent = JSON.stringify(
              data.history,
              null,
              2
            );
          }

          function updateUI(data) {
            document.getElementById('sessionId').textContent =
              data.sessionId || currentSessionId;
            document.getElementById('stateValue').textContent = JSON.stringify(
              data.state.value
            );
            document.getElementById('context').textContent = JSON.stringify(
              data.state.context,
              null,
              2
            );

            const agentDiv = document.getElementById('agent-response');
            if (data.agentResponse) {
              agentDiv.style.display = 'block';
              document.getElementById('agentResponseContent').textContent =
                JSON.stringify(data.agentResponse, null, 2);
            } else {
              agentDiv.style.display = 'none';
            }
          }
        </script>
      </body>
    </html>
  `);
});

// POST /sessions - Start new email session
app.post('/sessions', async (c) => {
  const body = await c.req.json<{ userRequest: string }>();

  const sessionId = db.createSession({
    userRequest: body.userRequest,
    recipient: '',
    subject: '',
    body: '',
    clarifications: [],
    questions: [],
  });

  const session = db.getSession(sessionId)!;

  const response: {
    sessionId: string;
    state: { value: unknown; context: Record<string, unknown> };
    agentResponse?: { type: string; [key: string]: unknown };
  } = {
    sessionId,
    state: { value: session.value, context: session.context },
  };

  // Initial state requires agent decision
  if (requiresAgentDecision(session.value)) {
    console.log('requiresAgentDecision', session.value);
    const event = await getAgentDecision(
      { value: session.value, context: session.context },
      'Help the user draft and send an email based on their request.',
      c.env.OPENAI_API_KEY
    );

    console.log('event', event);

    if (event) {
      const resolvedState = emailMachine.resolveState({
        value: session.value,
        context: session.context,
      });
      const [nextState] = transition(emailMachine, resolvedState, event as any);

      console.log('nextState', nextState);

      db.appendState(sessionId, {
        value: nextState.value,
        context: nextState.context,
        event,
      });

      response.state = { value: nextState.value, context: nextState.context };
      response.agentResponse = event;
    }
  }

  return c.json(response);
});

// POST /sessions/:id/events - Send event to session
app.post('/sessions/:id/events', async (c) => {
  const sessionId = c.req.param('id');
  const session = db.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const event = await c.req.json<{ type: string; [key: string]: unknown }>();

  // Transition with user event
  const resolvedState = emailMachine.resolveState({
    value: session.value,
    context: session.context,
  });
  const [nextState] = transition(emailMachine, resolvedState, event as any);

  db.appendState(sessionId, {
    value: nextState.value,
    context: nextState.context,
    event,
  });

  const response: {
    state: { value: unknown; context: Record<string, unknown> };
    agentResponse?: { type: string; [key: string]: unknown };
  } = {
    state: { value: nextState.value, context: nextState.context },
  };

  // If new state requires agent, call LLM
  if (requiresAgentDecision(nextState.value)) {
    console.log('requiresAgentDecision', nextState.value);
    const agentEvent = await getAgentDecision(
      { value: nextState.value, context: nextState.context },
      'Continue helping draft the email based on the clarifications provided.',
      c.env.OPENAI_API_KEY
    );

    console.log('agentEvent', agentEvent);

    if (agentEvent) {
      const [afterAgentState] = transition(
        emailMachine,
        emailMachine.resolveState({
          value: nextState.value,
          context: nextState.context,
        }),
        agentEvent as any
      );

      console.log('afterAgentState', afterAgentState);

      db.appendState(sessionId, {
        value: afterAgentState.value,
        context: afterAgentState.context,
        event: agentEvent,
      });

      response.state = {
        value: afterAgentState.value,
        context: afterAgentState.context,
      };
      response.agentResponse = agentEvent;
    }
  }

  return c.json(response);
});

// GET /sessions/:id - Get current state
app.get('/sessions/:id', (c) => {
  const sessionId = c.req.param('id');
  const session = db.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({
    sessionId,
    state: { value: session.value, context: session.context },
  });
});

// GET /sessions/:id/history - Get full append-only history
app.get('/sessions/:id/history', (c) => {
  const sessionId = c.req.param('id');
  const session = db.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ sessionId, history: session.history });
});

export default app;
