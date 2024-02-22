import { useEffect, useState } from 'react';
import './App.css';

export function TicTacToe() {
  const [board, setBoard] = useState<string[]>(Array(9).fill(''));
  const [gameSummary, setGameSummary] = useState<string | null>(null);

  useEffect(() => {
    const serverPort = import.meta.env.VITE_API_PORT;
    const eventSource = new EventSource(
      `http://localhost:${serverPort}/tic-tac-toe`,
    );

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const { value, context } = data.message;

        if (context?.events) {
          const lastEvent = JSON.parse((context?.events ?? []).at(-1));
          const { type, index } = lastEvent;
          const player = type.split('.')[0].toUpperCase();

          setBoard((prevBoard) => {
            const newBoard = [...prevBoard];
            newBoard[index] = player;
            return newBoard;
          });

          if (value.gameOver) {
            const summaryMsg =
              value.gameOver === 'draw'
                ? `Game over: ${value.gameOver}`
                : `Game over: ${value.gameOver} is ${player.toUpperCase()}`;

            setGameSummary(summaryMsg);
            eventSource.onmessage = null;
            eventSource.close();
            return;
          }
        }
      } catch (error) {
        console.error('Error parsing incoming message from server:', error);
      }
    };

    return () => {
      eventSource.onmessage = null;
      eventSource.close();
    };
  }, []);

  return (
    <>
      <h2>Tic Tac Toe</h2>
      <p className="read-the-docs mb-10">So easy, AI can play it!</p>
      <div id="board" className="w-96">
        <div className="grid grid-cols-3 gap-0">
          {board.map((cell, index) => {
            return (
              <div
                key={index}
                className={`border-4 border-black border-solid w-auto h-32 pt-3 text-8xl text-center text-vertical-center ${getTextColor(cell)}`}
              >
                {cell}
              </div>
            );
          })}
        </div>
      </div>
      {gameSummary && (
        <div
          className={`text-2xl font-bold text-center mt-8 ${getTextColor('')}`}
        >
          {gameSummary}
        </div>
      )}
    </>
  );
}

function getTextColor(text: string) {
  const lowerCaseText = text.toLowerCase();
  switch (lowerCaseText) {
    case 'o':
      return 'text-blue-700';
    case 'x':
      return 'text-red-700';
    default:
      return 'text-gray-700';
  }
}
