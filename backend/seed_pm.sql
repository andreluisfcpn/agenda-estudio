INSERT INTO payment_method_config (key, label, short_label, emoji, description, color, active, sort_order, access_mode, updated_at) VALUES
('PIX', 'PIX', 'PIX', '⚡', 'Pagamento instantâneo', '#22c55e', true, 0, 'FULL', NOW()),
('CARTAO', 'Cartão de Crédito', 'Cartão', '💳', 'Crédito ou débito', '#8b5cf6', true, 1, 'FULL', NOW()),
('BOLETO', 'Boleto Bancário', 'Boleto', '📄', 'Compensação em até 3 dias úteis', '#f59e0b', true, 2, 'PROGRESSIVE', NOW())
ON CONFLICT (key) DO NOTHING;
