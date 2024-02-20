import * as dotenv from 'dotenv';
import * as express from 'express';
import * as cors from 'cors';

import { createJokeMachine } from './examples/joke';

dotenv.config();

const app = express();

app.use(
  cors({
    origin: 'http://localhost:3000',
  })
);
app.use(express.json());

const port = 3001; // Use a different port from Vite's default (3000)

let jokeAgent;

app.get('/joke', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Function to send a message
  const sendEvent = (data) => {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    res.write(message);
  };

  sendEvent({ message: 'Connection established' });

  // Clean up when the connection is closed
  req.on('close', () => res.end());

  const sendToClient = (message: string) => sendEvent({ message });
  const { agent } = createJokeMachine({ log: sendToClient });
  jokeAgent = agent;

  agent.subscribe((state) => {
    console.log('state.value', state.value);
  });
});

app.post('/joke-set-topic', (req, res) => {
  const topic = req.body.topic;
  jokeAgent.send({ type: 'setTopic', topic });

  res.send(200);
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
