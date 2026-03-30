UPDATE payment_method_config SET emoji = E'\u26A1', label = 'PIX', short_label = 'PIX', description = E'Pagamento instant\u00E2neo' WHERE key = 'PIX';
UPDATE payment_method_config SET emoji = E'\U0001F4B3', label = E'Cart\u00E3o de Cr\u00E9dito', short_label = E'Cart\u00E3o', description = E'Cr\u00E9dito ou d\u00E9bito' WHERE key = 'CARTAO';
UPDATE payment_method_config SET emoji = E'\U0001F4C4', label = E'Boleto Banc\u00E1rio', short_label = 'Boleto', description = E'Compensa\u00E7\u00E3o em at\u00E9 3 dias \u00FAteis' WHERE key = 'BOLETO';
