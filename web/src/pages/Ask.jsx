import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Chat from '../components/Chat.jsx';
import Icon from '../components/Icon.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const SUGGEST = ['What did we decide this week?', 'List all open action items by owner', 'What did customers ask about most?', 'Draw an ASCII timeline of my meetings this week'];

export default function Ask() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [titles, setTitles] = useState({});
  const [chatKey, setChatKey] = useState(0);
  const [started, setStarted] = useState(false);
  useEffect(() => { api.get('/meetings').then((r) => setTitles(Object.fromEntries(r.items.map((m) => [m._id, m.title])))).catch(() => {}); }, []);

  return (
    <div className="ask-home no-rail">
      <section className="ask-main">
        {started && <button className="btn sm new-chat" onClick={() => { setStarted(false); setChatKey((k) => k + 1); }}><Icon name="newchat" size={15} />New chat</button>}
        <Chat key={chatKey} home name={user.name.split(/\s+/)[0]} suggestions={SUGGEST} titles={titles} placeholder="Ask anything..."
          onCite={(id, t) => nav(`/meeting/${id}?t=${t}`)}
          onMessages={(m) => setStarted(m.length > 0)} />
      </section>
    </div>
  );
}
