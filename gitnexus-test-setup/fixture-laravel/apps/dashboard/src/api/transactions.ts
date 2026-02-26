import Axios from 'axios';

export const toggleAcknowledgeTransaction = (transactionId: number, shouldAcknowledge: boolean) => {
  return Axios.post(
    `/transactions/${transactionId}/${shouldAcknowledge ? 'acknowledge' : 'unacknowledge'}`,
  );
};
