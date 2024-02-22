import * as dotenv from 'dotenv';
import * as express from 'express';
import * as cors from 'cors';
import { createTicTacToeAgent } from './ticTacToe';

dotenv.config();

const app = express();

app.use(
  cors({
    origin: `http://localhost:${process.env.VITE_PORT}`,
  }),
);
app.use(express.json());

app.get('/tic-tac-toe', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Function to send a message
  const sendEvent = (data: { message: unknown }) => {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    res.write(message);
  };

  sendEvent({ message: 'Connection established' });

  const ticTacToeAgent = createTicTacToeAgent();

  // Clean up when the connection is closed
  req.on('close', () => {
    ticTacToeAgent.stop();
    res.end();
  });

  ticTacToeAgent.subscribe((state) => {
    sendEvent({ message: state });
  });
  ticTacToeAgent.start();
});

app.listen(process.env.VITE_API_PORT, () => {
  console.log(
    `Example app listening at http://localhost:${process.env.VITE_API_PORT}`,
  );
});
