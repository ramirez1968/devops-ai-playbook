import React, { useState } from 'react';
import {
  Container,
  Typography,
  Box,
  Button,
  Grid,
  Paper,
  Divider,
  TextField,
  Alert,
  CircularProgress,
} from '@mui/material';
import { Lock as LockIcon } from '@mui/icons-material';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useCart } from '../../contexts/CartContext';
import { orderService } from '../../services/orderService';
import { Address } from '../../types';

// Same rules the orders service applies; the server's total is what gets charged.
const FREE_SHIPPING_OVER = 500;
const SHIPPING_FEE = 15;
const TAX_RATE = 0.08;

const emptyAddress: Address = { street: '', city: '', state: '', zipCode: '', country: 'US' };

const Checkout: React.FC = () => {
  const { items, total, clearCart } = useCart();
  const navigate = useNavigate();
  const [address, setAddress] = useState<Address>(emptyAddress);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = total;
  const shipping = subtotal > FREE_SHIPPING_OVER ? 0 : SHIPPING_FEE;
  const tax = subtotal * TAX_RATE;
  const finalTotal = subtotal + shipping + tax;

  const addressComplete = Object.values(address).every(v => v.trim() !== '');

  const handleChange = (field: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setAddress({ ...address, [field]: e.target.value });

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const order = await orderService.createOrder({
        items: items.map(item => ({ productId: item.id, quantity: item.quantity })),
        shippingAddress: address,
      });
      clearCart();
      navigate('/orders', { state: { placedOrderId: order.id } });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not place the order. Please try again.');
      setSubmitting(false);
    }
  };

  if (items.length === 0) {
    return (
      <Container maxWidth="md" sx={{ py: 8, textAlign: 'center' }}>
        <Typography variant="h4" gutterBottom>
          Your cart is empty
        </Typography>
        <Button variant="contained" component={RouterLink} to="/products" sx={{ mt: 2 }}>
          Browse products
        </Button>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Typography variant="h3" component="h1" gutterBottom>
        Checkout
      </Typography>

      <Grid container spacing={4} component="form" onSubmit={handlePlaceOrder}>
        <Grid size={{ xs: 12, md: 8 }}>
          <Paper elevation={2} sx={{ p: 3 }}>
            <Typography variant="h5" gutterBottom sx={{ fontWeight: 600 }}>
              Shipping address
            </Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12 }}>
                <TextField label="Street" value={address.street} onChange={handleChange('street')} required fullWidth />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField label="City" value={address.city} onChange={handleChange('city')} required fullWidth />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField label="State" value={address.state} onChange={handleChange('state')} required fullWidth />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField label="ZIP code" value={address.zipCode} onChange={handleChange('zipCode')} required fullWidth />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField label="Country" value={address.country} onChange={handleChange('country')} required fullWidth />
              </Grid>
            </Grid>
          </Paper>

          <Alert severity="info" sx={{ mt: 3 }}>
            This is a demo store: no payment is taken. Your order is saved with payment status "pending".
          </Alert>
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <Paper elevation={2} sx={{ p: 3, position: 'sticky', top: 24 }}>
            <Typography variant="h5" gutterBottom sx={{ fontWeight: 600 }}>
              Order Summary
            </Typography>

            {items.map(item => (
              <Box key={item.id} sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2">
                  {item.name} × {item.quantity}
                </Typography>
                <Typography variant="body2">${(item.price * item.quantity).toFixed(2)}</Typography>
              </Box>
            ))}

            <Divider sx={{ my: 2 }} />

            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body1">Subtotal:</Typography>
              <Typography variant="body1">${subtotal.toFixed(2)}</Typography>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body1">Shipping:</Typography>
              <Typography variant="body1">{shipping === 0 ? 'FREE' : `$${shipping.toFixed(2)}`}</Typography>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="body1">Tax:</Typography>
              <Typography variant="body1">${tax.toFixed(2)}</Typography>
            </Box>
            <Divider sx={{ mb: 2 }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>Total:</Typography>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>${finalTotal.toFixed(2)}</Typography>
            </Box>

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={!addressComplete || submitting}
              startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : <LockIcon />}
            >
              {submitting ? 'Placing order…' : 'Place order'}
            </Button>
            <Button component={RouterLink} to="/cart" fullWidth sx={{ mt: 1 }}>
              Back to cart
            </Button>
          </Paper>
        </Grid>
      </Grid>
    </Container>
  );
};

export default Checkout;
