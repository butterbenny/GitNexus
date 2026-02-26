import { useQuery } from '@tanstack/react-query';
import { fetchUsersViaClient } from '../api/instanceClient';
import { usersQueryKeys } from './usersQueryKeys';

export const useUsersQuery = () => {
  return useQuery({
    queryKey: [usersQueryKeys.all()],
    queryFn: () => fetchUsersViaClient(),
  });
};
