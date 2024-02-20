import * as dotenv from 'dotenv';
import * as express from 'express';
import * as cors from 'cors';
import { createTicTacToeAgent } from './ticTacToe';

dotenv.config();

const app = express();

app.use(
  cors({
    origin: 'http://localhost:3000',
  })
);
app.use(express.json());

const port = 3001; // Use a different port from Vite's default (3000)

app.get('/tic-tac-toe', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Function to send a message
  const sendEvent = (data) => {
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

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
