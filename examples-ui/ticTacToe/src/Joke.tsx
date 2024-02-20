import { useEffect, useState } from 'react';
import './App.css';

export function Joke() {
  const [formEnabled, setFormEnabled] = useState(true);

  useEffect(() => {
    const eventSource = new EventSource('http://localhost:3001/joke');

    eventSource.onmessage = (event) => {
      const eventList = document.getElementById('events');
      const newElement = document.createElement('div');

      try {
        const data = JSON.parse(event.data);

        if (data.message === 'exit') {
          const form = document.getElementById(
            'examples-form',
          ) as HTMLFormElement;
          form?.reset();
          setFormEnabled(false);
          return;
        }

        newElement.textContent = data.message;
        eventList?.appendChild(newElement);
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
      <h2>Joke Generator</h2>
      <p className="read-the-docs mb-10">
        We'll keep you laughing all day long!
      </p>

      <div
        id="events"
        className="border-4 text-lg font-medium text-left w-96 h-96 overflow-auto"
      ></div>
      <div className="my-8 w-96">
        <form
          id="examples-form"
          // set this form as disabled
          // when the server sends a final event
          onSubmit={async (event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = event.target as HTMLFormElement;
            const formData = new FormData(form);

            try {
              await fetch('http://localhost:3001/joke-set-topic', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ topic: formData.get('topic') }),
              });
            } catch (error) {
              console.error('Error:', error);
            }
          }}
        >
          <div className="flex-col w-full">
            <label className="block text-left">Joke topic</label>
            <input
              name="topic"
              type="text"
              className="w-full"
              disabled={!formEnabled}
            />
          </div>
          <button
            type="submit"
            className="block ml-auto mt-4"
            disabled={!formEnabled}
          >
            Submit
          </button>
        </form>
      </div>
      <div className="border-16 border-black border-solid w-10 h-10"></div>
    </>
  );
}
