import { useState } from 'react';
import './App.css';
import { Joke } from './Joke';
import { TicTacToe } from './TicTacToe';

function App() {
  const [exampleId, setExampleId] = useState<string | null>(null);

  return (
    <>
      <h1>Stately Agent Examples</h1>
      <button onClick={() => setExampleId('joke')}>Joke</button>
      <button onClick={() => setExampleId('tic-tac-toe')}>Tic Tac Toe</button>
      {exampleId && exampleId === 'joke' ? (
        <Joke />
      ) : exampleId === 'tic-tac-toe' ? (
        <TicTacToe />
      ) : null}
    </>
  );
}

export default App;
