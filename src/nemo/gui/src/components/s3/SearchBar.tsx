import { Input } from '@fluentui/react-components'
import { Search24Regular } from '@fluentui/react-icons'
import { makeStyles } from '@fluentui/react-components'

const useStyles = makeStyles({
  searchBar: {
    width: '100%',
  },
})

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function SearchBar({ value, onChange, placeholder = 'Search buckets, folders, and files...' }: SearchBarProps) {
  const styles = useStyles()
  
  return (
    <div className={styles.searchBar}>
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(_, data) => onChange(data.value)}
        contentBefore={<Search24Regular />}
        style={{ flex: 1 }}
      />
    </div>
  )
}

