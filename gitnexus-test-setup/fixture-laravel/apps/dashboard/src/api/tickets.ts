import Axios from 'axios';

export const revokeTicket = (ticketId: number) => {
  return Axios.post(`/tickets/${ticketId}/revoke`);
};

