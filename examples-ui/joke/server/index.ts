import * as dotenv from 'dotenv';
import * as express from 'express';
import * as cors from 'cors';

import { createJokeMachine } from './joke';

dotenv.config();

const app = express();

app.use(
  cors({
    origin: `http://localhost:${process.env.VITE_PORT}`,
  }),
);
app.use(express.json());

let jokeAgent: ReturnType<typeof createJokeMachine>;

app.get('/joke', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Function to send a message
  const sendEvent = (data: { message: string }) => {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    res.write(message);
  };

  sendEvent({ message: 'Connection established' });

  // Clean up when the connection is closed
  req.on('close', () => res.end());

  const sendToClient = (message: string) => sendEvent({ message });
  const agent = createJokeMachine({ log: sendToClient });
  jokeAgent = agent;

  jokeAgent.subscribe((state) => {
    console.log('state.value', state.value);
  });
  jokeAgent.start();
});

app.post('/joke-set-topic', (req, res) => {
  const topic = req.body.topic;
  jokeAgent.send({ type: 'setTopic', topic });

  res.send(200);
});

app.listen(process.env.VITE_API_PORT, () => {
  console.log(
    `Example app listening at http://localhost:${process.env.VITE_API_PORT}`,
  );
});
