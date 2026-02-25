<script lang="ts">
  import { formatLabel } from '../utils';

  export let label: string = 'OK';

  const getButtonLabel = () => formatLabel(label);
</script>

<button>{getButtonLabel()}</button>
