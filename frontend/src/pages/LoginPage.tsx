import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AmbientBackground from '../components/AmbientBackground';
import LoginModal from '../components/LoginModal';

// A rota /login reaproveita o LoginModal (padrão do sistema, usado também na landing)
// sobre o background ambiente e a cor de fundo padrão. Fechar o modal volta para a landing.
export default function LoginPage() {
    const navigate = useNavigate();
    const [open, setOpen] = useState(true);

    return (
        <div className="login-page">
            <AmbientBackground />
            <LoginModal
                isOpen={open}
                onClose={() => { setOpen(false); navigate('/'); }}
            />
        </div>
    );
}
