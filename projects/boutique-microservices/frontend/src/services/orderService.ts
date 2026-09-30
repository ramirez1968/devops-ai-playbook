import apiClient from './api';
import { Order, Address } from '../types';

// The orders API wraps results as { success, data }.
export const orderService = {
  createOrder: async (orderData: {
    items: { productId: string; quantity: number }[];
    shippingAddress: Address;
  }): Promise<Order> => {
    const response = await apiClient.post('/orders', orderData);
    return response.data.data;
  },

  getUserOrders: async (): Promise<Order[]> => {
    const response = await apiClient.get('/orders/my-orders');
    return response.data.data;
  },

  getOrderById: async (id: string): Promise<Order> => {
    const response = await apiClient.get(`/orders/${id}`);
    return response.data.data;
  },

  updateOrderStatus: async (id: string, status: string): Promise<Order> => {
    const response = await apiClient.patch(`/orders/${id}/status`, { status });
    return response.data.data;
  },
};
